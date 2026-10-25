import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        sevenDay: fileURLToPath(new URL('./seven-day.html', import.meta.url)),
        monthly: fileURLToPath(new URL('./monthly.html', import.meta.url)),
        yearly: fileURLToPath(new URL('./yearly.html', import.meta.url)),
        confirmPlan: fileURLToPath(new URL('./confirm-plan.html', import.meta.url)),
        paymentStatus: fileURLToPath(new URL('./payment-status.html', import.meta.url)),
      },
    },
  },
});
