import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/** Serve / copy the top-level `demo/` scene JSON folder. */
function demoScenesPlugin() {
  const demoRoot = path.resolve('demo');

  return {
    name: 'demo-scenes',
    configureServer(server) {
      server.middlewares.use('/demo', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const filePath = path.resolve(demoRoot, '.' + (rel === '/' ? '' : rel));
        if (!filePath.startsWith(demoRoot + path.sep) && filePath !== demoRoot) {
          return next();
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return next();
        }
        if (filePath.endsWith('.json')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
        } else if (filePath.endsWith('.js')) {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        }
        fs.createReadStream(filePath).pipe(res);
      });
    },
    closeBundle() {
      if (!fs.existsSync(demoRoot)) return;
      const dest = path.resolve('dist', 'demo');
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(demoRoot, dest, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [demoScenesPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
