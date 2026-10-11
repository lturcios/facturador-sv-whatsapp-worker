# facturador-sv-whatsapp-worker

Microservicio independiente y desacoplado para la transmisión de Comprobantes Tributarios Electrónicos (DTE) por WhatsApp en **Facturador El Salvador**, utilizando **Baileys (Multi-Device)** y el patrón **Transactional Outbox sobre PostgreSQL**.

---

## 🏗️ Arquitectura y Principios de Diseño

1. **Transactional Outbox:** El core de facturación (`facturador-sv`) emite y firma el DTE en una transacción ACID en PostgreSQL e inserta el registro en `whatsapp_outbox`. Si la factura falla, no se encola nada.
2. **Desacoplamiento Absoluto:** El worker se ejecuta en un proceso/contenedor independiente. Si la conexión de WhatsApp de un cliente falla, el flujo de facturación tributaria no sufre ningún retraso.
3. **Control Anti-Baneo:**
   - **Verificación previa:** Comprueba si el destinatario existe en WhatsApp con `sock.onWhatsApp(jid)` antes de enviar.
   - **Jitter Humano:** Aplica pausas aleatorias de entre 8 y 16 segundos entre envíos para simular tráfico humano.
4. **Persistencia de Sesiones Multi-Tenant:** Cada empresa almacena sus credenciales en `sessions_data/company_${companyId}` sobre un volumen de disco, permitiendo auto-reconexión tras reinicios sin solicitar reescaneo de código QR.
5. **Detección de Revocación Remota (`loggedOut`):** Si el cliente desvincula su teléfono desde la app de WhatsApp, el worker limpia el directorio en disco de inmediato y actualiza la base de datos para notificar al panel de control.

---

## 🚀 Instalación y Puesta en Marcha

### Requisitos
- Node.js v20 o v22+
- Acceso a la base de datos PostgreSQL de `facturador-sv`

### Desarrollo Local
```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Configurar DB_HOST, DB_NAME, DB_USER, DB_PASSWORD

# 3. Iniciar en modo desarrollo
npm run dev
```

### Despliegue con Docker
```bash
docker compose up -d --build
```

---

## 📡 API Interna (Puerto 3005)

Este microservicio expone endpoints internos consumidos por el backend principal `facturador-sv`:

| Método | Endpoint | Descripción |
| :--- | :--- | :--- |
| `GET` | `/health` | Chequeo de salud del worker y uptime |
| `POST` | `/internal/sessions/:companyId/connect` | Inicia o solicita QR para una empresa |
| `POST` | `/internal/sessions/:companyId/disconnect` | Cierra sesión y purga tokens de disco |
| `GET` | `/internal/sessions/:companyId/status` | Devuelve el estado en memoria del socket |
