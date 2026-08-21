import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      /**
       * Progressive Web App.
       *
       * This makes the app installable from the browser on each PC (it then opens
       * in its own window like a desktop program) and lets it update itself: when
       * the HP serves a new build, clients pick it up automatically on next launch,
       * with no reinstall.
       *
       * Crucially, only the *app shell* (HTML/JS/CSS) is precached. Every `/api`
       * call is left to go to the network — financial data is never served from a
       * cache, so what staff see is always live. If the server is unreachable, the
       * app still opens from cache and the reconnect banner (see src/lib/api.ts)
       * takes over.
       */
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Villaggio Del Sol — Property Operations',
          short_name: 'Villaggio Del Sol',
          description: 'Internal property operations system for Villaggio Del Sol, Ocho Rios, Jamaica.',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          scope: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ]
        },
        workbox: {
          // App-shell fallback for client-side routes, but never for the API.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api/],
          // Do not precache source maps or the data file.
          globIgnores: ['**/*.map', '**/db.json'],
          // No runtime caching of /api — it must always hit the network so
          // balances, receipts and arrears are never stale.
          runtimeCaching: [],
          cleanupOutdatedCaches: true
        },
        // The service worker is only active for the real (production) build; in dev
        // it stays off so it can't serve stale bundles while editing.
        devOptions: { enabled: false }
      })
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.')
      }
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {}
    }
  };
});
