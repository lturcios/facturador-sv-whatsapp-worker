// src/server/internalApi.ts
import express, { Request, Response } from 'express';
import { SessionManager } from '../baileys/sessionManager';

export function createInternalApp(sessionManager: SessionManager) {
    const app = express();
    app.use(express.json());

    // Healthcheck
    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    // Iniciar conexión o solicitar QR
    app.post('/internal/sessions/:companyId/connect', async (req: Request, res: Response) => {
        const companyId = parseInt(req.params.companyId as string, 10);
        if (isNaN(companyId)) {
            res.status(400).json({ error: 'companyId inválido' });
            return;
        }

        try {
            console.log(`[Internal API] Solicitud de conexión para empresa ${companyId}`);
            // Inicia la sesión en segundo plano
            sessionManager.initOrGetSession(companyId).catch((err) => {
                console.error(`[Internal API] Error inicializando sesión para empresa ${companyId}:`, err.message);
            });

            res.json({ message: 'Proceso de conexión iniciado', companyId });
        } catch (error: any) {
            console.error(`Error en connect para empresa ${companyId}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Desconectar sesión
    app.post('/internal/sessions/:companyId/disconnect', async (req: Request, res: Response) => {
        const companyId = parseInt(req.params.companyId as string, 10);
        if (isNaN(companyId)) {
            res.status(400).json({ error: 'companyId inválido' });
            return;
        }

        try {
            console.log(`[Internal API] Solicitud de desconexión para empresa ${companyId}`);
            await sessionManager.disconnectSession(companyId);
            res.json({ message: 'Sesión desconectada y limpiada', companyId });
        } catch (error: any) {
            console.error(`Error en disconnect para empresa ${companyId}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Estado en memoria de la sesión
    app.get('/internal/sessions/:companyId/status', (req: Request, res: Response) => {
        const companyId = parseInt(req.params.companyId as string, 10);
        if (isNaN(companyId)) {
            res.status(400).json({ error: 'companyId inválido' });
            return;
        }

        const isConnected = sessionManager.isConnected(companyId);
        res.json({ companyId, isConnected });
    });

    return app;
}
