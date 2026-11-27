import { build, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { trainerStudioPlugin } from './viteTrainerPlugin';

function offlineHtmlExportPlugin(): Plugin {
  let cachedHtml: string | null = null;
  let pendingBuild: Promise<string> | null = null;

  const buildSingleFileHtml = async (): Promise<string> => {
    const result = await build({
      configFile: false,
      mode: 'production',
      root: __dirname,
      base: './',
      publicDir: false,
      logLevel: 'silent',
      plugins: [react(), tailwindcss(), viteSingleFile()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        },
      },
      build: {
        write: false,
        emptyOutDir: false,
        cssCodeSplit: false,
        assetsInlineLimit: 100_000_000,
        chunkSizeWarningLimit: 5000,
      },
    });

    const outputs = Array.isArray(result) ? result : [result];
    for (const out of outputs) {
      if ('output' in out) {
        const htmlAsset = out.output.find(
          (item) => item.type === 'asset' && item.fileName.endsWith('.html')
        );
        if (htmlAsset && htmlAsset.type === 'asset' && typeof htmlAsset.source === 'string') {
          return htmlAsset.source;
        }
      }
    }
    throw new Error('Failed to generate single-file offline HTML output.');
  };

  return {
    name: 'offline-html-export',
    configureServer(server) {
      server.middlewares.use('/__offline_export.html', async (req, res) => {
        try {
          const forceFresh = req.url?.includes('fresh=1');
          if (!cachedHtml || forceFresh) {
            if (!pendingBuild) {
              pendingBuild = buildSingleFileHtml().finally(() => {
                pendingBuild = null;
              });
            }
            cachedHtml = await pendingBuild;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader(
            'Content-Disposition',
            'attachment; filename="innovation-4th-edition-offline.html"'
          );
          res.end(cachedHtml);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(err instanceof Error ? err.message : 'Failed to build offline HTML.');
        }
      });
    },
  };
}

export default defineConfig(({ command }) => {
  return {
    base: './',
    publicDir: 'public',
    plugins: [
      react(),
      tailwindcss(),
      viteSingleFile(),
      offlineHtmlExportPlugin(),
      ...(command === 'serve' ? [trainerStudioPlugin()] : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: 'dist',
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      chunkSizeWarningLimit: 5000,
    },
  };
});
