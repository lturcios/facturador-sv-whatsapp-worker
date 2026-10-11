// src/baileys/sessionManager.ts
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState, 
    WASocket 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import pool from '../config/database';

export class SessionManager {
    private sockets: Map<number, WASocket> = new Map();
    private reconnectTimeouts: Map<number, NodeJS.Timeout> = new Map();
    private baseSessionsDir: string;

    constructor() {
        this.baseSessionsDir = path.resolve(process.env.SESSIONS_DIR || './sessions_data');
    }

    private getSessionPath(companyId: number): string {
        return path.join(this.baseSessionsDir, `company_${companyId}`);
    }

    /**
     * Obtiene el socket activo de una empresa si está conectado.
     */
    public getSocket(companyId: number): WASocket | undefined {
        return this.sockets.get(companyId);
    }

    /**
     * Verifica si la sesión de una empresa está activa en memoria.
     */
    public isConnected(companyId: number): boolean {
        return this.sockets.has(companyId);
    }

    /**
     * Inicializa o recupera la sesión de Baileys para una empresa.
     */
    public async initOrGetSession(companyId: number): Promise<WASocket> {
        // Si ya existe un socket activo en memoria, retornarlo
        const existing = this.sockets.get(companyId);
        if (existing) {
            return existing;
        }

        const sessionPath = this.getSessionPath(companyId);
        await fs.mkdir(sessionPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Facturador SV', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            syncFullHistory: false
        });

        this.sockets.set(companyId, sock);

        // Guardar credenciales criptográficas cada vez que se actualicen
        sock.ev.on('creds.update', saveCreds);

        // Monitoreo de ciclo de vida de conexión
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // 1. Emitir código QR para el frontend
            if (qr) {
                try {
                    const qrDataUrl = await qrcode.toDataURL(qr);
                    await pool.query(
                        `UPDATE whatsapp_sessions 
                         SET status = 'qr_ready', qr_code = $1, session_dir = $2, updated_at = NOW() 
                         WHERE company_id = $3`,
                        [qrDataUrl, sessionPath, companyId]
                    );
                    console.log(`[Empresa ${companyId}] Código QR generado y disponible para el frontend.`);
                } catch (qrErr: any) {
                    console.error(`[Empresa ${companyId}] Error al generar DataURL de QR:`, qrErr);
                }
            }

            // 2. Conexión establecida con éxito
            if (connection === 'open') {
                const rawPhone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null;
                console.log(`[Empresa ${companyId}] WhatsApp Conectado exitosamente. Teléfono: ${rawPhone}`);

                await pool.query(
                    `UPDATE whatsapp_sessions 
                     SET status = 'connected', qr_code = null, phone_number = $1, 
                         is_active = true, last_connected_at = NOW(), 
                         last_disconnect_reason = null, updated_at = NOW() 
                     WHERE company_id = $2`,
                    [rawPhone, companyId]
                );
            }

            // 3. Conexión cerrada o interrumpida
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                console.warn(`[Empresa ${companyId}] Conexión cerrada con código: ${statusCode}. LoggedOut: ${isLoggedOut}`);

                if (isLoggedOut) {
                    // El cliente cerró sesión explícitamente desde su teléfono móvil
                    console.warn(`[Empresa ${companyId}] Sesión revocada desde la app móvil. Limpiando credenciales.`);
                    this.sockets.delete(companyId);

                    try {
                        await fs.rm(sessionPath, { recursive: true, force: true });
                    } catch (rmErr) {
                        console.error(`Error borrando directorio de sesión de empresa ${companyId}:`, rmErr);
                    }

                    await pool.query(
                        `UPDATE whatsapp_sessions 
                         SET status = 'disconnected', qr_code = null, is_active = false, 
                             last_disconnect_reason = 'Sesión revocada desde la app de WhatsApp del teléfono',
                             updated_at = NOW() 
                         WHERE company_id = $1`,
                        [companyId]
                    );
                } else {
                    // Desconexión temporal (red, reinicio de servidor de WhatsApp, timeout)
                    this.sockets.delete(companyId);

                    await pool.query(
                        `UPDATE whatsapp_sessions 
                         SET status = 'connecting', 
                             last_disconnect_reason = $1, updated_at = NOW() 
                         WHERE company_id = $2`,
                        [`Reconectando tras caída temporal (${statusCode})`, companyId]
                    );

                    // Reintentar conexión automática tras 5 segundos
                    const timeout = setTimeout(() => {
                        console.log(`[Empresa ${companyId}] Reintentando reconexión automática...`);
                        this.initOrGetSession(companyId).catch(err => {
                            console.error(`[Empresa ${companyId}] Fallo al reconectar:`, err.message);
                        });
                    }, 5000);

                    this.reconnectTimeouts.set(companyId, timeout);
                }
            }
        });

        return sock;
    }

    /**
     * Cierra y destruye la sesión de una empresa (desconexión manual).
     */
    public async disconnectSession(companyId: number): Promise<void> {
        const timeout = this.reconnectTimeouts.get(companyId);
        if (timeout) {
            clearTimeout(timeout);
            this.reconnectTimeouts.delete(companyId);
        }

        const sock = this.sockets.get(companyId);
        if (sock) {
            try {
                await sock.logout();
            } catch (err) {
                // Ignore logout errors if socket already closed
            }
            this.sockets.delete(companyId);
        }

        const sessionPath = this.getSessionPath(companyId);
        try {
            await fs.rm(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.error(`Error al borrar carpeta de sesión:`, err);
        }

        await pool.query(
            `UPDATE whatsapp_sessions 
             SET status = 'disconnected', qr_code = null, is_active = false, 
                 last_disconnect_reason = 'Desconectado manualmente desde el panel',
                 updated_at = NOW() 
             WHERE company_id = $1`,
            [companyId]
        );
    }

    /**
     * Restaura automáticamente las sesiones que estaban conectadas antes de reiniciar el worker.
     */
    public async autoRestoreSessions(): Promise<void> {
        try {
            const { rows } = await pool.query(
                `SELECT company_id FROM whatsapp_sessions WHERE status = 'connected' OR is_active = true`
            );

            console.log(`[SessionManager] Restaurando ${rows.length} sesiones activas tras inicio...`);

            for (const row of rows) {
                const sessionPath = this.getSessionPath(row.company_id);
                try {
                    await fs.access(sessionPath);
                    console.log(`[SessionManager] Reconectando empresa ${row.company_id}...`);
                    await this.initOrGetSession(row.company_id);
                } catch {
                    console.log(`[SessionManager] Directorio de sesión ausente para empresa ${row.company_id}. Marcando desconectada.`);
                    await pool.query(
                        `UPDATE whatsapp_sessions SET status = 'disconnected', is_active = false WHERE company_id = $1`,
                        [row.company_id]
                    );
                }
            }
        } catch (error: any) {
            console.error('[SessionManager] Error restaurando sesiones automáticas:', error.message);
        }
    }
}
