import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(webDirectory, 'client'),
  plugins: [react()],
  build: {
    outDir: resolve(webDirectory, 'dist/client'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'antd-icons',
              test: /node_modules[\\/]@ant-design[\\/]icons/,
              priority: 25,
            },
            {
              name: 'rc-vendor',
              test: /node_modules[\\/](?:@rc-component|rc-[^\\/]+)[\\/]/,
              priority: 22,
            },
            {
              name: 'antd-vendor',
              test: /node_modules[\\/](?:antd|@ant-design)[\\/]/,
              priority: 20,
            },
            {
              name: 'markdown-vendor',
              test: /node_modules[\\/](?:react-markdown|remark-|rehype-|unified|micromark|mdast|hast|unist)/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
