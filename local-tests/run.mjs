import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

class LocalTestRunner {
  constructor() {
    this.directory = fileURLToPath(new URL('.', import.meta.url));
    assert.ok(process.env.WEB_CLIENT_ROOT, 'Set WEB_CLIENT_ROOT to the client checkout being tested.');
    assert.ok(isAbsolute(process.env.WEB_CLIENT_ROOT), 'WEB_CLIENT_ROOT must be an absolute path.');
    this.client = resolve(process.env.WEB_CLIENT_ROOT);
  }

  async run(args) {
    await stat(join(this.client, 'app.js'));
    const files = (await readdir(join(this.directory, 'tests'))).sort();
    if (args[0] === '--list') {
      assert.equal(args.length, 1, 'Use --list without test filenames.');
      console.log(files.join('\n'));
      return;
    }
    const serve = args[0] === '--serve';
    if (serve) assert.equal(args.length, 1, 'Use --serve without test filenames.');
    const selected = args.length && !serve
      ? args
      : files.filter(name => /\.test\.(mjs|cjs)$/.test(name) && !name.includes('.browser.'));
    for (const name of selected) {
      assert.ok(files.includes(name) && /\.test\.(mjs|cjs)$/.test(name), `Unknown test: ${name}. Use --list.`);
    }
    const workspace = await this.prepareWorkspace();
    try {
      console.log(`Client: ${this.client}`);
      if (serve) await this.serve(workspace);
      else this.test(workspace, selected);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async prepareWorkspace() {
    const workspace = await mkdtemp(join(tmpdir(), 'liberdus-local-tests-'));
    try {
      // Copy tests: symlinking them would make ESM resolve ../ against this repository.
      await cp(join(this.directory, 'tests'), join(workspace, 'tests'), { recursive: true });
      await cp(join(this.directory, 'fixtures'), join(workspace, 'fixtures'), { recursive: true });
      const assetDirectories = ['bridge', 'data', 'explorer', 'external', 'fonts', 'media', 'meet', 'mock', 'network', 'dev-fixtures', 'dev-patches'];
      for (const entry of await readdir(this.client, { withFileTypes: true })) {
        if ((entry.isFile() && /\.(js|html|css)$/.test(entry.name)) || assetDirectories.includes(entry.name)) {
          await symlink(join(this.client, entry.name), join(workspace, entry.name));
        }
      }
      await symlink(resolve(this.directory, '../playwright-tests/node_modules'), join(workspace, 'node_modules'));
      return workspace;
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  test(workspace, selected) {
    let failures = 0;
    for (const name of selected) {
      console.log(`\nRunning ${name}`);
      // Plain Node also supports imported node:test suites and preserves standalone scripts.
      const result = spawnSync(process.execPath, [join(workspace, 'tests', name)], {
        cwd: workspace,
        stdio: 'inherit',
        timeout: 120_000,
      });
      if (result.error) console.error(result.error.message);
      const passed = result.status === 0;
      failures += Number(!passed);
      console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    }
    console.log(`\nFiles: ${selected.length}; passed: ${selected.length - failures}; failed: ${failures}`);
    process.exitCode = failures ? 1 : 0;
  }

  async serve(workspace) {
    const server = createServer((request, response) => this.serveFile(workspace, request, response));
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(8765, '127.0.0.1', accept);
    });
    console.log('Serving client and fixtures at http://127.0.0.1:8765/tests/<fixture>.html (Ctrl+C to stop).');
    const stop = () => server.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await new Promise(accept => server.once('close', accept));
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }

  async serveFile(workspace, request, response) {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(workspace, `.${pathname}`);
      assert.ok(path.startsWith(workspace + sep) && !pathname.split('/').some(part => part.startsWith('.') || part === 'node_modules'));
      const contents = await readFile(path);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  }
}

try {
  await new LocalTestRunner().run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
