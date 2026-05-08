// Release-only webpack config for KeepSync extension.
//
// For local development you do NOT need this — the source tree under
// ./extension is already a loadable unpacked extension. Use this config
// only when producing a minified zip for Web Store / AMO submission:
//
//   npm run build           # Chrome build → ./dist
//   npm run build:firefox   # Firefox build → ./dist
//
// The source has no ES modules / require() calls, so webpack's job here
// is just: pick the right manifest, copy static files, and minify JS.
// No babel-loader needed — target browsers (Chrome 109+, Firefox 109+)
// support everything in the source tree natively.

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const target = env?.target || 'chrome';

  return {
    entry: {
      'src/background/background': [
        './shared/logger.js',
        './shared/api-client.js',
        './shared/storage.js',
        './src/background/sync-manager.js',
        './src/background/tab-manager.js',
        './src/background/bookmark-manager.js',
        './src/background/background.js'
      ],
      'src/popup/popup': './src/popup/popup.js',
      'src/options/options': './src/options/options.js',
      'src/offscreen/offscreen': './src/offscreen/offscreen.js'
    },

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true
    },

    mode: isProduction ? 'production' : 'development',
    devtool: isProduction ? false : 'inline-source-map',

    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        'shared': path.resolve(__dirname, 'shared')
      }
    },

    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          {
            from: target === 'firefox' ? 'manifest.firefox.json' : 'manifest.chrome.json',
            to: 'manifest.json',
            transform: (content) => {
              const m = JSON.parse(content.toString());
              m.background =
                target === 'firefox'
                  ? { scripts: ['src/background/background.js'] }
                  : { service_worker: 'src/background/background.js' };
              return JSON.stringify(m, null, 2);
            }
          },
          { from: 'src/popup/popup.html', to: 'src/popup/popup.html' },
          { from: 'src/popup/popup.css', to: 'src/popup/popup.css' },
          { from: 'src/options/options.html', to: 'src/options/options.html' },
          { from: 'src/options/options.css', to: 'src/options/options.css' },
          { from: 'src/offscreen/offscreen.html', to: 'src/offscreen/offscreen.html' },
          { from: 'icons', to: 'icons' },
          { from: 'shared', to: 'shared' }
        ]
      })
    ],

    optimization: {
      minimize: isProduction,
      splitChunks: false
    },

    experiments: {
      outputModule: false
    },

    target: ['web', 'es2020']
  };
};
