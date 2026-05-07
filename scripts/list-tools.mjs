#!/usr/bin/env node
import { createServer } from '../dist/server.js';
process.env.ODOO_URL = 'http://x';
process.env.ODOO_DB = 'x';
process.env.ODOO_USERNAME = 'x';
process.env.ODOO_PASSWORD = 'x';

const { server } = createServer(false);
const names = Object.keys(server._registeredTools).sort();
console.log('Total:', names.length);
names.forEach((n, i) => console.log(`${String(i + 1).padStart(2, '0')}. ${n}`));
