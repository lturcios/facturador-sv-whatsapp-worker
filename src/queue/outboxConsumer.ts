// src/queue/outboxConsumer.ts
import pool from '../config/database';
import { SessionManager } from '../baileys/sessionManager';
import { readDteFile } from '../utils/fileReader';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OutboxConsumer {
    private sessionManager: SessionManager;
    private isRunning: boolean = false;
    private intervalId: NodeJS.Timeout | null = null;
    private isProcessing: boolean = false;

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
    }

    public start(pollIntervalMs: number = 10000) {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`[OutboxConsumer] Iniciado loop de consumo con sondeo cada ${pollIntervalMs / 1000}s`);

        // Ejecutar inmediatamente y luego por intervalo
        this.processBatch();
        this.intervalId = setInterval(() => this.processBatch(), pollIntervalMs);
    }

    public stop() {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        console.log('[OutboxConsumer] Loop detenido.');
    }

    private async processBatch() {
        if (this.isProcessing || !this.isRunning) return;
        this.isProcessing = true;

        try {
            await this.processNextMessage();
        } catch (err: any) {
            console.error('[OutboxConsumer] Error procesando mensaje de la cola:', err.message);
        } finally {
            this.isProcessing = false;
        }
    }

    private async processNextMessage(): Promise<void> {
        const client = await pool.connect();
        let job: any = null;

        try {
            await client.query('BEGIN');

            // 1. Obtener mensaje pendiente utilizando SKIP LOCKED para no colisionar con otras instancias
            const { rows } = await client.query(`
                SELECT id, company_id, reference_type, reference_id, recipient_phone,
                       recipient_name, message_text, pdf_path, json_path, attempts, max_attempts
                FROM whatsapp_outbox
                WHERE status = 'pending' AND scheduled_at <= NOW() AND attempts < max_attempts
                ORDER BY id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `);

            if (rows.length === 0) {
                await client.query('COMMIT');
                return;
            }

            job = rows[0];

            // 2. Verificar si la empresa tiene WhatsApp conectado
            const sock = this.sessionManager.getSocket(job.company_id);
            if (!sock || !this.sessionManager.isConnected(job.company_id)) {
                console.log(`[OutboxConsumer] Mensaje ${job.id} pospuesto: la empresa ${job.company_id} no está conectada a WhatsApp.`);
                await client.query(`
                    UPDATE whatsapp_outbox 
                    SET scheduled_at = NOW() + INTERVAL '5 minutes',
                        last_error = 'Sesión de WhatsApp no conectada actualmente'
                    WHERE id = $1
                `, [job.id]);
                await client.query('COMMIT');
                return;
            }

            // Marcar mensaje en proceso
            await client.query(`
                UPDATE whatsapp_outbox 
                SET status = 'processing', attempts = attempts + 1 
                WHERE id = $1
            `, [job.id]);
            await client.query('COMMIT');

            // 3. Verificar si el número de teléfono existe en WhatsApp
            const jid = `${job.recipient_phone}@s.whatsapp.net`;
            console.log(`[OutboxConsumer] Verificando número ${job.recipient_phone} en WhatsApp...`);
            
            const results = await sock.onWhatsApp(jid);
            const verified = results && results.length > 0 && results[0]?.exists;

            if (!verified) {
                console.warn(`[OutboxConsumer] Número ${job.recipient_phone} no está registrado en WhatsApp.`);
                await pool.query(`
                    UPDATE whatsapp_outbox 
                    SET status = 'invalid_number', last_error = 'Número no registrado en WhatsApp', updated_at = NOW()
                    WHERE id = $1
                `, [job.id]);
                return;
            }

            // 4. Jitter humano anti-ban (espera aleatoria entre 8 y 16 segundos)
            const jitterMs = Math.floor(Math.random() * (16000 - 8000 + 1)) + 8000;
            console.log(`[OutboxConsumer] Aplicando espera de ritmo anti-ban (${jitterMs / 1000}s) antes de enviar DTE ${job.reference_id}...`);
            await sleep(jitterMs);

            // 5. Cargar archivos adjuntos (PDF y JSON)
            console.log(`[OutboxConsumer] Cargando adjuntos para DTE ${job.reference_id}...`);
            const pdfBuffer = await readDteFile(job.pdf_path);
            const jsonBuffer = await readDteFile(job.json_path);

            // 6. Enviar mensajes en secuencia:
            // A. Cuerpo del comprobante en texto
            console.log(`[OutboxConsumer] Transmitiendo texto a ${jid}...`);
            await sock.sendMessage(jid, { text: job.message_text });

            // Pequeño retardo entre mensajes de la misma factura (1.5 segundos)
            await sleep(1500);

            // B. Representación Gráfica (PDF)
            console.log(`[OutboxConsumer] Transmitiendo PDF a ${jid}...`);
            await sock.sendMessage(jid, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: `${job.reference_id}.pdf`
            });

            await sleep(1500);

            // C. Estructura Electrónica firmada (JSON)
            console.log(`[OutboxConsumer] Transmitiendo JSON a ${jid}...`);
            await sock.sendMessage(jid, {
                document: jsonBuffer,
                mimetype: 'application/json',
                fileName: `${job.reference_id}.json`
            });

            // 7. Marcar éxito
            await pool.query(`
                UPDATE whatsapp_outbox 
                SET status = 'sent', sent_at = NOW(), last_error = null 
                WHERE id = $1
            `, [job.id]);

            console.log(`[OutboxConsumer] ✅ DTE ${job.reference_id} entregado con éxito por WhatsApp a ${job.recipient_phone}`);

        } catch (error: any) {
            console.error(`[OutboxConsumer] ❌ Error procesando mensaje ${job?.id}:`, error.message);
            if (job) {
                await pool.query(`
                    UPDATE whatsapp_outbox 
                    SET status = 'failed', 
                        last_error = $1,
                        scheduled_at = NOW() + INTERVAL '10 minutes'
                    WHERE id = $2
                `, [error.message, job.id]);
            }
        } finally {
            client.release();
        }
    }
}
