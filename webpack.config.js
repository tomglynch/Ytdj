const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    background: './src/background/index.ts',
    content: './src/content/index.ts',
    controller: './src/controller/index.ts',
    offscreen: './src/offscreen/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
        { from: 'src/icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
    new HtmlWebpackPlugin({
      template: './src/controller/controller.html',
      filename: 'controller.html',
      chunks: ['controller'],
    }),
  ],
  devtool: 'cheap-module-source-map',
};
