import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to every network interface, not just localhost — lets other
    // machines on the same LAN (packing stations) reach this dev server at
    // http://<this-PC's-IP>:5173 instead of needing the whole project
    // installed locally on every station.
    host: true,
    allowedHosts: ['lethargic-headed-opponent.ngrok-free.dev'],
  },
})
