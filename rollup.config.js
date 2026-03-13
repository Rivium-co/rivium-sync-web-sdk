import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';

export default {
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/index.js',
      format: 'cjs',
      sourcemap: true,
      exports: 'named',
      inlineDynamicImports: true,
    },
    {
      file: 'dist/index.esm.js',
      format: 'esm',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: 'dist/index.umd.js',
      format: 'umd',
      name: 'RiviumSync',
      sourcemap: true,
      exports: 'named',
      inlineDynamicImports: true,
      globals: {
        mqtt: 'mqtt',
      },
    },
  ],
  plugins: [
    json(),
    resolve({
      browser: true,
      preferBuiltins: false,
      mainFields: ['browser', 'module', 'main'],
    }),
    commonjs({
      transformMixedEsModules: true,
      requireReturnsDefault: 'auto',
    }),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: true,
      declarationDir: 'dist',
    }),
    terser(),
  ],
  external: [],
};
