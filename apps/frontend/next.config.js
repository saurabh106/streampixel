const fs = require('fs');
const path = require('path');

// Dynamically locate and load the root .env file from the monorepo root
function loadRootEnv() {
  let dir = __dirname;
  let envPath = null;
  while (dir && dir !== path.parse(dir).root) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'streampixel-monorepo') {
          envPath = path.join(dir, '.env');
          break;
        }
      } catch {}
    }
    if (fs.existsSync(path.join(dir, 'apps')) && fs.existsSync(path.join(dir, 'packages'))) {
      envPath = path.join(dir, '.env');
      break;
    }
    dir = path.dirname(dir);
  }

  if (!envPath) {
    envPath = path.resolve(__dirname, '../../.env');
  }

  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    for (const line of envConfig.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const firstEquals = trimmed.indexOf('=');
      if (firstEquals === -1) continue;
      const key = trimmed.slice(0, firstEquals).trim();
      let val = trimmed.slice(firstEquals + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadRootEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};
module.exports = nextConfig;
