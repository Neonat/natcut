export const projects = [
  {
    test: {
      name: 'submission',
      root: './apps/submission',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'visitor',
      root: './apps/visitor',
      include: ['test/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
    },
  },
  {
    test: {
      name: 'worker',
      root: './apps/worker',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'domain',
      root: './packages/domain',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'render',
      root: './packages/render',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'cut-geometry',
      root: './packages/cut-geometry',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
] as const;

export default projects;
