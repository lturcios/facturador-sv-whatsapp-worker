// src/utils/fileReader.ts
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const useB2 = process.env.USE_B2_STORAGE === 'true';

const b2Client = useB2 ? new S3Client({
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    region: 'us-west-004',
    credentials: {
        accessKeyId: process.env.B2_KEY_ID || '',
        secretAccessKey: process.env.B2_APPLICATION_KEY || ''
    },
    forcePathStyle: true
}) : null;

const bucketName = process.env.B2_BUCKET_NAME || '';
const localBaseDir = process.env.LOCAL_STORAGE_BASE_PATH || path.join(__dirname, '../../../facturador-sv');

/**
 * Convierte un Stream a Buffer.
 */
const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
};

/**
 * Lee un archivo de comprobante DTE (PDF o JSON) desde Backblaze B2 o disco local.
 * @param filePath Ruta relativa (ej: "/storage/1/202610/xyz.pdf") o URL de B2
 */
export const readDteFile = async (filePath: string): Promise<Buffer> => {
    try {
        if (useB2 && filePath.startsWith('https://')) {
            const url = new URL(filePath);
            const key = url.pathname.substring(1); // Remover "/" inicial

            if (!b2Client) throw new Error('Cliente B2 no inicializado');

            const command = new GetObjectCommand({
                Bucket: bucketName,
                Key: key
            });

            const result = await b2Client.send(command);
            if (result.Body instanceof Readable) {
                return await streamToBuffer(result.Body);
            }
            throw new Error('Respuesta inesperada de B2');
        } else {
            // Limpiar ruta inicial si empieza con '/'
            const relativePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
            const fullLocalPath = path.resolve(localBaseDir, relativePath);
            return await fs.readFile(fullLocalPath);
        }
    } catch (error: any) {
        console.error(`[FileReader] Error al leer archivo ${filePath}:`, error.message);
        throw error;
    }
};
