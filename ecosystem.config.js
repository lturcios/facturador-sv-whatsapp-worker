module.exports = {
  apps: [
    {
      name: 'whatsapp-worker',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      restart_delay: 3000,
      max_restarts: 10,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3005
      }
    }
  ]
};
