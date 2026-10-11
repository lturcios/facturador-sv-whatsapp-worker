// src/index.ts
import dotenv from 'dotenv';
import pool from './config/database';
import { SessionManager } from './baileys/sessionManager';
import { OutboxConsumer } from './queue/outboxConsumer';
import { createInternalApp } from './server/internalApi';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3005', 10);

async function bootstrap() {
    console.log('====================================================');
    console.log('🚀 Iniciando facturador-sv-whatsapp-worker (Baileys)');
    console.log('====================================================');

    // 1. Verificar conexión a PostgreSQL
    try {
        const { rows } = await pool.query('SELECT NOW()');
        console.log(`[DB] Conectado exitosamente a PostgreSQL (${rows[0].now})`);
    } catch (dbErr: any) {
        console.error('❌ Error conectando a PostgreSQL:', dbErr.message);
        process.exit(1);
    }

    // 2. Instanciar SessionManager y OutboxConsumer
    const sessionManager = new SessionManager();
    const outboxConsumer = new OutboxConsumer(sessionManager);

    // 3. Iniciar Servidor HTTP Interno
    const app = createInternalApp(sessionManager);
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`[API Interna] Escuchando en http://0.0.0.0:${PORT}`);
    });

    // 4. Restaurar sesiones previas de empresas activas
    await sessionManager.autoRestoreSessions();

    // 5. Iniciar Loop de Consumo del Outbox
    outboxConsumer.start(10000); // Sondeo cada 10 segundos

    // Manejo de apagado elegante (Graceful Shutdown)
    const shutdown = async (signal: string) => {
        console.log(`\n[Worker] Recibida señal ${signal}. Apagando ordenadamente...`);
        outboxConsumer.stop();
        server.close();
        await pool.end();
        console.log('[Worker] Servicios cerrados con éxito.');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
    console.error('Fallo crítico al iniciar el worker:', err);
    process.exit(1);
});
