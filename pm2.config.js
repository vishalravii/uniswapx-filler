module.exports = {
  apps: [
    {
      name: 'uniswapx-filler',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file:   './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Restart if it crashes, but back-off exponentially up to 30s
      exp_backoff_restart_delay: 100,
      max_restarts: 20,
      restart_delay: 1_000,
    },
  ],
};
