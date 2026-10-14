import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root = new URL('../client/', import.meta.url);
createServer(async (req, res) => {
  try {
    if (req.url === '/main.js') {
      let js = await readFile(new URL('main.js', root), 'utf8');
      js = js
        .replace(
          /import\s+\{[^}]*\}\s+from\s+['"]firebase\/app['"];/,
          'const initializeApp = value => value;',
        )
        .replace(
          /import\s+\{[^}]*\}\s+from\s+['"]firebase\/auth['"];/,
          'const {getAuth,onIdTokenChanged,GoogleAuthProvider,signInWithPopup,signOut} = window.testAuth;',
        )
        .replace(
          /import\s+\{[^}]*\}\s+from\s+['"]socket.io-client['"];/,
          'const io = window.testIO;',
        )
        .replace(/import\s+['"]\.\/style\.css['"];/, '');
      res.setHeader('Content-Type', 'text/javascript');
      res.end(js);
    } else if (req.url === '/links.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(new URL('links.js', root)));
    } else if (req.url === '/style.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(await readFile(new URL('style.css', root)));
    } else if (req.url.startsWith('/api/')) {
      res.writeHead(404);
      res.end('{}');
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        (await readFile(new URL('index.html', root), 'utf8')).replace(
          '</head>',
          '<link rel="stylesheet" href="/style.css"></head>',
        ),
      );
    }
  } catch {
    res.writeHead(500);
    res.end();
  }
}).listen(4173, '127.0.0.1');
