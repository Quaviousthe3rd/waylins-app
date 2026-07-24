import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Settlement tests run against an in-memory Firestore; the real
      // firebase-admin lives only in functions/node_modules anyway.
      'firebase-admin/firestore': path.resolve(__dirname, 'tests/mocks/firestore.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Deliberately WEST of UTC: naive new Date('yyyy-MM-dd') parsing passes
    // in South Africa (UTC+2) by luck and breaks here. The availability
    // tests exist to fail under this TZ if anyone reintroduces it.
    env: { TZ: 'America/Los_Angeles' },
  },
});
