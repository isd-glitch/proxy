// 拡張版インターステラープロキシ - 高度な機能を備えたプロキシサーバー
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const zlib = require('zlib');
const stream = require('stream');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// セッションシークレットの生成
const SESSION_SECRET = crypto.randomBytes(64).toString('hex');

// ミドルウェアの設定
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24時間
}));

// 静的ファイルの提供
app.use(express.static('public'));

// プロキシのキャッシュディレクトリを確保
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ベースURLを取得する関数
function getBaseUrl(urlString) {
  const parsedUrl = new URL(urlString);
  return `${parsedUrl.protocol}//${parsedUrl.host}`;
}

// URLが相対パスかどうかをチェック
function isRelativePath(urlString) {
  return !urlString.startsWith('http') && !urlString.startsWith('//') && !urlString.startsWith('data:');
}

// ファイル拡張子からMIMEタイプを取得
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'font/otf',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.php': 'text/html',
    '.py': 'text/plain',
    '.rb': 'text/plain',
    '.sh': 'text/plain',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
}

// HTMLコンテンツを修正してプロキシ経由でリソースを読み込むように変更
async function processHtml(html, baseUrl, requestUrl) {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // ベースURLの設定 (存在しない場合)
    if (!document.querySelector('base')) {
      const baseElement = document.createElement('base');
      baseElement.href = baseUrl;
      document.head.insertBefore(baseElement, document.head.firstChild);
    }

    // すべてのリンクをプロキシ経由に変更
    function processAttribute(elements, attribute) {
      elements.forEach(element => {
        const attrValue = element.getAttribute(attribute);
        if (attrValue && isRelativePath(attrValue)) {
          let absoluteUrl;
          if (attrValue.startsWith('/')) {
            absoluteUrl = new URL(attrValue, baseUrl).href;
          } else {
            // ページURLからの相対パス
            const pageDir = requestUrl.substring(0, requestUrl.lastIndexOf('/') + 1);
            absoluteUrl = new URL(attrValue, pageDir).href;
          }
          element.setAttribute(attribute, `/proxy?url=${encodeURIComponent(absoluteUrl)}`);
        } else if (attrValue && (attrValue.startsWith('http') || attrValue.startsWith('//'))) {
          element.setAttribute(attribute, `/proxy?url=${encodeURIComponent(attrValue.startsWith('//') ? 'https:' + attrValue : attrValue)}`);
        }
      });
    }

    // a href属性の処理
    processAttribute(Array.from(document.querySelectorAll('a[href]')), 'href');
    
    // link href属性の処理
    processAttribute(Array.from(document.querySelectorAll('link[href]')), 'href');
    
    // img src属性の処理
    processAttribute(Array.from(document.querySelectorAll('img[src]')), 'src');
    
    // script src属性の処理
    processAttribute(Array.from(document.querySelectorAll('script[src]')), 'src');
    
    // form action属性の処理
    processAttribute(Array.from(document.querySelectorAll('form[action]')), 'action');
    
    // iframe src属性の処理
    processAttribute(Array.from(document.querySelectorAll('iframe[src]')), 'src');
    
    // video srcの処理
    processAttribute(Array.from(document.querySelectorAll('video[src]')), 'src');
    processAttribute(Array.from(document.querySelectorAll('source[src]')), 'src');
    
    // audio srcの処理
    processAttribute(Array.from(document.querySelectorAll('audio[src]')), 'src');
    
    // CSSのbackground-image等を処理するためのスクリプトを挿入
    const proxyScript = document.createElement('script');
    proxyScript.textContent = `
      // インラインスタイルとCSSファイルのURLをプロキシで処理
      window.addEventListener('DOMContentLoaded', function() {
        // MutationObserverを設定して動的に追加される要素も処理
        const observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            if (mutation.addedNodes) {
              mutation.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) { // エレメントノードの場合
                  processNewElement(node);
                }
              });
            }
          });
        });
        
        observer.observe(document.body, { childList: true, subtree: true });
        
        // インラインスタイルの処理
        function processInlineStyles(element) {
          if (element.style && element.style.backgroundImage) {
            const bgImage = element.style.backgroundImage;
            if (bgImage.includes('url(') && !bgImage.includes('data:')) {
              const urlMatch = bgImage.match(/url\\(['"]?([^'"\\)]+)['"]?\\)/);
              if (urlMatch && urlMatch[1]) {
                const originalUrl = urlMatch[1];
                if (!originalUrl.startsWith('data:')) {
                  let absoluteUrl;
                  if (isRelativePath(originalUrl)) {
                    absoluteUrl = new URL(originalUrl, "${baseUrl}").href;
                  } else {
                    absoluteUrl = originalUrl;
                  }
                  element.style.backgroundImage = 'url("/proxy?url=' + encodeURIComponent(absoluteUrl) + '")';
                }
              }
            }
          }
        }
        
        // 新しく追加された要素の処理
        function processNewElement(element) {
          processInlineStyles(element);
          
          // すべての子要素も処理
          const allChildren = element.querySelectorAll('*');
          allChildren.forEach(processInlineStyles);
          
          // イベントリスナーの置き換え (特定のリンクのデフォルト動作を防止)
          if (element.tagName === 'A' || element.querySelectorAll('a').length > 0) {
            const links = element.tagName === 'A' ? [element] : element.querySelectorAll('a');
            links.forEach(link => {
              link.addEventListener('click', function(e) {
                const href = this.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  window.location.href = this.href;
                }
              });
            });
          }
        }
        
        // 既存の要素の処理
        document.querySelectorAll('*').forEach(processInlineStyles);
        
        // CSSルールの処理（スタイルシート内のURL）
        Array.from(document.styleSheets).forEach(function(sheet) {
          try {
            if (sheet.cssRules) {
              Array.from(sheet.cssRules).forEach(function(rule) {
                if (rule.style && rule.style.cssText.includes('url(')) {
                  const cssText = rule.style.cssText;
                  const urlRegex = /url\\(['"]?([^'"\\)]+)['"]?\\)/g;
                  let match;
                  let newCssText = cssText;
                  
                  while ((match = urlRegex.exec(cssText)) !== null) {
                    const originalUrl = match[1];
                    if (!originalUrl.startsWith('data:')) {
                      let absoluteUrl;
                      if (isRelativePath(originalUrl)) {
                        absoluteUrl = new URL(originalUrl, "${baseUrl}").href;
                      } else {
                        absoluteUrl = originalUrl;
                      }
                      newCssText = newCssText.replace(
                        'url(' + originalUrl + ')', 
                        'url("/proxy?url=' + encodeURIComponent(absoluteUrl) + '")'
                      );
                    }
                  }
                  
                  if (newCssText !== cssText) {
                    rule.style.cssText = newCssText;
                  }
                }
              });
            }
          } catch (e) {
            console.warn('CSSルール処理エラー:', e);
          }
        });
      });
      
      // XHRとFetchリクエストをインターセプト
      (function() {
        // オリジナルのXHR open関数を保存
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
          // URLがプロキシでない場合は変換
          if (url && typeof url === 'string' && !url.startsWith('/proxy') && !url.startsWith('data:')) {
            let absoluteUrl;
            if (isRelativePath(url)) {
              absoluteUrl = new URL(url, "${baseUrl}").href;
            } else {
              absoluteUrl = url;
            }
            arguments[1] = '/proxy?url=' + encodeURIComponent(absoluteUrl);
          }
          return originalXhrOpen.apply(this, arguments);
        };
        
        // オリジナルのfetch関数を保存
        const originalFetch = window.fetch;
        window.fetch = function(resource, init) {
          if (resource && typeof resource === 'string' && !resource.startsWith('/proxy') && !resource.startsWith('data:')) {
            let absoluteUrl;
            if (isRelativePath(resource)) {
              absoluteUrl = new URL(resource, "${baseUrl}").href;
            } else {
              absoluteUrl = resource;
            }
            resource = '/proxy?url=' + encodeURIComponent(absoluteUrl);
          }
          return originalFetch.call(this, resource, init);
        };
        
        // ページナビゲーションをインターセプト
        function isRelativePath(url) {
          return url && typeof url === 'string' && !url.startsWith('http') && !url.startsWith('//') && !url.startsWith('#') && !url.startsWith('javascript:') && !url.startsWith('data:');
        }
      })();
    `;
    document.body.appendChild(proxyScript);
    
    // プロキシ状態表示バー挿入
    const proxyBar = document.createElement('div');
    proxyBar.id = 'interstellar-proxy-bar';
    proxyBar.innerHTML = `
      <div class="proxy-info">インターステラープロキシ経由: ${requestUrl}</div>
      <div class="proxy-controls">
        <button id="fullscreen-btn">全画面表示</button>
        <button id="view-source-btn">ソース表示</button>
        <button id="hide-bar-btn">バーを隠す</button>
      </div>
    `;
    proxyBar.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: rgba(0, 0, 0, 0.85);
      color: #00ccff;
      padding: 8px 15px;
      font-family: Arial, sans-serif;
      z-index: 2147483647;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
      font-size: 14px;
    `;
    
    // プロキシバーのスタイルとスクリプト
    const proxyBarScript = document.createElement('script');
    proxyBarScript.textContent = `
      document.addEventListener('DOMContentLoaded', function() {
        const bar = document.getElementById('interstellar-proxy-bar');
        
        // スタイル適用
        const barControls = bar.querySelector('.proxy-controls');
        barControls.style.cssText = 'display: flex; gap: 10px;';
        
        const buttons = bar.querySelectorAll('button');
        buttons.forEach(btn => {
          btn.style.cssText = 'background: #00ccff; color: #000; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;';
          btn.addEventListener('mouseover', () => {
            btn.style.background = '#33d6ff';
          });
          btn.addEventListener('mouseout', () => {
            btn.style.background = '#00ccff';
          });
        });
        
        // 全画面表示ボタン
        document.getElementById('fullscreen-btn').addEventListener('click', function() {
          const elem = document.documentElement;
          if (!document.fullscreenElement) {
            if (elem.requestFullscreen) {
              elem.requestFullscreen();
            } else if (elem.webkitRequestFullscreen) {
              elem.webkitRequestFullscreen();
            } else if (elem.msRequestFullscreen) {
              elem.msRequestFullscreen();
            }
          } else {
            if (document.exitFullscreen) {
              document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
              document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
              document.msExitFullscreen();
            }
          }
        });
        
        // ソース表示ボタン
        document.getElementById('view-source-btn').addEventListener('click', function() {
          window.open('/view-source?url=${encodeURIComponent(requestUrl)}', '_blank');
        });
        
        // バー非表示ボタン
        document.getElementById('hide-bar-btn').addEventListener('click', function() {
          bar.style.transform = 'translateY(-100%)';
          
          // 表示ボタン作成
          const showBtn = document.createElement('button');
          showBtn.textContent = 'プロキシバー表示';
          showBtn.style.cssText = 'position: fixed; top: 5px; right: 5px; z-index: 2147483646; background: rgba(0,0,0,0.7); color: #00ccff; border: 1px solid #00ccff; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;';
          document.body.appendChild(showBtn);
          
          showBtn.addEventListener('click', function() {
            bar.style.transform = 'translateY(0)';
            showBtn.remove();
          });
        });
        
        // バーのアニメーション
        bar.style.transition = 'transform 0.3s ease';
        
        // メインコンテンツのマージン調整
        document.body.style.marginTop = (bar.offsetHeight + 5) + 'px';
      });
    `;
    document.body.appendChild(proxyBarScript);
    
    return dom.serialize();
  } catch (error) {
    console.error('HTML処理エラー:', error);
    return html; // エラーが発生した場合は元のHTMLを返す
  }
}

// CSS内のURLをプロキシ経由に変換
function processCss(css, baseUrl) {
  return css.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, url) => {
    if (url.startsWith('data:')) return match;
    
    let absoluteUrl;
    if (isRelativePath(url)) {
      absoluteUrl = new URL(url, baseUrl).href;
    } else {
      absoluteUrl = url.startsWith('//') ? 'https:' + url : url;
    }
    
    return `url("/proxy?url=${encodeURIComponent(absoluteUrl)}")`;
  });
}

// JavaScriptの処理（必要に応じてXHRやfetchをプロキシに向ける）
function processJs(js, baseUrl) {
  // 単純な置換では限界があるため、静的解析や動的インジェクションで対応
  // ここでは基本的な置換のみ実装
  return js;
}

// メインページのHTMLを返す
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ファイルソース表示機能
app.get('/view-source', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).send('URLパラメータが必要です');
  }
  
  try {
    const response = await axios({
      method: 'get',
      url: targetUrl,
      responseType: 'text',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
      }
    });
    
    const contentType = response.headers['content-type'] || '';
    let highlightLanguage = 'html';
    
    if (contentType.includes('javascript')) {
      highlightLanguage = 'javascript';
    } else if (contentType.includes('css')) {
      highlightLanguage = 'css';
    } else if (contentType.includes('json')) {
      highlightLanguage = 'json';
    } else if (contentType.includes('xml')) {
      highlightLanguage = 'xml';
    } else if (targetUrl.endsWith('.php')) {
      highlightLanguage = 'php';
    } else if (targetUrl.endsWith('.py')) {
      highlightLanguage = 'python';
    }
    
    const sourceContent = response.data;
    const escapedSource = sourceContent
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    const html = `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>ソースコード: ${targetUrl}</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
      <script>hljs.highlightAll();</script>
      <style>
        body {
          background-color: #1a1a2e;
          color: #cccccc;
          font-family: Monaco, monospace;
          margin: 0;
          padding: 20px;
        }
        header {
          background: #000;
          color: #00ccff;
          padding: 15px;
          margin: -20px -20px 20px -20px;
          border-bottom: 1px solid #333;
        }
        h1 {
          font-size: 18px;
          margin: 0;
        }
        .url {
          color: #aaa;
          font-size: 14px;
          overflow-wrap: break-word;
          margin-top: 5px;
        }
        .controls {
          margin-top: 10px;
          display: flex;
          gap: 10px;
        }
        button {
          background: #00ccff;
          color: #000;
          border: none;
          padding: 6px 12px;
          border-radius: 3px;
          cursor: pointer;
        }
        button:hover {
          background: #33d6ff;
        }
        pre {
          background-color: #282c34;
          padding: 15px;
          border-radius: 5px;
          overflow-x: auto;
          margin: 0;
        }
        code {
          font-family: Monaco, monospace;
          font-size: 14px;
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <header>
        <h1>ソースコード表示</h1>
        <div class="url">${targetUrl}</div>
        <div class="controls">
          <button onclick="window.location.href='/proxy?url=${encodeURIComponent(targetUrl)}'">ページに戻る</button>
          <button onclick="copyToClipboard()">コピー</button>
          <button onclick="downloadSource()">ダウンロード</button>
        </div>
      </header>
      
      <pre><code class="language-${highlightLanguage}">${escapedSource}</code></pre>
      
      <script>
        function copyToClipboard() {
          const code = document.querySelector('code').innerText;
          navigator.clipboard.writeText(code)
            .then(() => alert('コードをクリップボードにコピーしました'))
            .catch(err => alert('コピーできませんでした: ' + err));
        }
        
        function downloadSource() {
          const code = document.querySelector('code').innerText;
          const blob = new Blob([code], { type: 'text/plain' });
          const a = document.createElement('a');
          const filename = '${targetUrl.split('/').pop() || 'source'}';
          a.download = filename;
          a.href = window.URL.createObjectURL(blob);
          a.click();
        }
      </script>
    </body>
    </html>
    `;
    
    res.send(html);
  } catch (error) {
    res.status(500).send(`<html><body><h1>エラー</h1><p>${error.message}</p><p><a href="/">ホームに戻る</a></p></body></html>`);
  }
});

// プロキシ機能の実装
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).send('URLパラメータが必要です');
  }
  
  try {
    // URLの検証と正規化
    const parsedUrl = new URL(targetUrl);
    const baseUrl = getBaseUrl(targetUrl);
    
    // キャッシュキーの生成
    const cacheKey = crypto.createHash('md5').update(targetUrl).digest('hex');
    const cachePath = path.join(CACHE_DIR, cacheKey);
    
    // ヘッダーの準備
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': targetUrl
    };
    
    // Cookieを追加
    if (req.session.cookies && req.session.cookies[parsedUrl.hostname]) {
      headers['Cookie'] = req.session.cookies[parsedUrl.hostname];
    }
    
    // GETリクエストの送信
    const response = await axios({
      method: 'get',
      url: targetUrl,
      responseType: 'arraybuffer', // バイナリデータとして受け取る
      timeout: 15000,
      headers: headers,
      maxRedirects: 5, // リダイレクトを自動的に処理
      validateStatus: status => status < 500 // 4xxエラーも処理する
    });
    
    // Cookieの保存
    if (response.headers['set-cookie']) {
      if (!req.session.cookies) {
        req.session.cookies = {};
      }
      req.session.cookies[parsedUrl.hostname] = response.headers['set-cookie'].join('; ');
    }
    
    // リダイレクト処理 (axiosの自動リダイレクトに対応できない場合)
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      let redirectUrl = response.headers.location;
      
      // 相対URLを絶対URLに変換
      if (isRelativePath(redirectUrl)) {
        redirectUrl = new URL(redirectUrl, targetUrl).href;
      } else if (redirectUrl.startsWith('//')) {
        redirectUrl = parsedUrl.protocol + redirectUrl;
      }
      
      // プロキシ経由でリダイレクト
      return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
    }
    
    // コンテンツタイプの取得と処理
    const contentType = response.headers['content-type'] || '';
    let body = response.data;
    
    // コンテンツエンコーディングの処理
    const contentEncoding = response.headers['content-encoding'];
    if (contentEncoding) {
      if (contentEncoding.includes('gzip')) {
        body = zlib.gunzipSync(body);
      } else if (contentEncoding.includes('deflate')) {
        body = zlib.inflateSync(body);
      } else if (contentEncoding.includes('br')) {
        body = zlib.brotliDecompressSync(body);
      }
    }
    
    // HTMLの場合、プロキシ用に処理
    if (contentType.includes('html')) {
      const bodyText = body.toString('utf-8');
      const processedHtml = await processHtml(bodyText, baseUrl, targetUrl);
      
      // レスポンスヘッダーの設定
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Proxy-Original-URL', targetUrl);
      
      // プロキシ処理したHTMLを返す
      return res.send(processedHtml);
    }
    
    // CSSの場合、URL参照を処理
    else if (contentType.includes('css')) {
      const cssText = body.toString('utf-8');
      const processedCss = processCss(cssText, baseUrl);
      
      // レスポンスヘッダーの設定
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('X-Proxy-Original-URL', targetUrl);
      
      // 処理したCSSを返す
      return res.send(processedCss);
    }
    
    // JavaScriptの場合、必要に応じて処理
    // JavaScriptの場合、必要に応じて処理
    else if (contentType.includes('javascript') || contentType.includes('js')) {
      const jsText = body.toString('utf-8');
      const processedJs = processJs(jsText, baseUrl);
      
      // レスポンスヘッダーの設定
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('X-Proxy-Original-URL', targetUrl);
      
      // 処理したJSを返す
      return res.send(processedJs);
    }
    
    // PHP、Pythonなどのソースコードファイルの場合
    else if (
      targetUrl.endsWith('.php') || 
      targetUrl.endsWith('.py') || 
      targetUrl.endsWith('.rb') || 
      targetUrl.endsWith('.java') ||
      targetUrl.endsWith('.cs')
    ) {
      // ソースコードとして表示する
      const sourceCode = body.toString('utf-8');
      
      // シンタックスハイライト用のHTMLを生成
      const html = `
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ソースコード: ${targetUrl}</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
        <script>hljs.highlightAll();</script>
        <style>
          body {
            background-color: #1a1a2e;
            color: #cccccc;
            font-family: Monaco, monospace;
            margin: 0;
            padding: 20px;
          }
          header {
            background: #000;
            color: #00ccff;
            padding: 15px;
            margin: -20px -20px 20px -20px;
            border-bottom: 1px solid #333;
          }
          h1 {
            font-size: 18px;
            margin: 0;
          }
          .url {
            color: #aaa;
            font-size: 14px;
            overflow-wrap: break-word;
            margin-top: 5px;
          }
          pre {
            background-color: #282c34;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            margin: 0;
          }
          code {
            font-family: Monaco, monospace;
            font-size: 14px;
            line-height: 1.5;
          }
          .controls {
            margin-top: 10px;
            display: flex;
            gap: 10px;
          }
          button {
            background: #00ccff;
            color: #000;
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
          }
          button:hover {
            background: #33d6ff;
          }
        </style>
      </head>
      <body>
        <header>
          <h1>ソースコード表示</h1>
          <div class="url">${targetUrl}</div>
          <div class="controls">
            <button onclick="window.history.back()">戻る</button>
            <button onclick="copyToClipboard()">コピー</button>
            <button onclick="downloadSource()">ダウンロード</button>
          </div>
        </header>
        
        <pre><code class="${getLanguageFromUrl(targetUrl)}">${sourceCode
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</code></pre>
        
        <script>
          function copyToClipboard() {
            const code = document.querySelector('code').innerText;
            navigator.clipboard.writeText(code)
              .then(() => alert('コードをクリップボードにコピーしました'))
              .catch(err => alert('コピーできませんでした: ' + err));
          }
          
          function downloadSource() {
            const code = document.querySelector('code').innerText;
            const blob = new Blob([code], { type: 'text/plain' });
            const a = document.createElement('a');
            const filename = '${targetUrl.split('/').pop() || 'source'}';
            a.download = filename;
            a.href = window.URL.createObjectURL(blob);
            a.click();
          }
        </script>
      </body>
      </html>
      `;
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    
    // その他のファイルタイプはそのまま転送
    else {
      // レスポンスヘッダーの転送（一部の問題になるヘッダーを除外）
      const excludeHeaders = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'host'];
      Object.keys(response.headers).forEach(header => {
        if (!excludeHeaders.includes(header.toLowerCase())) {
          res.setHeader(header, response.headers[header]);
        }
      });
      
      res.setHeader('X-Proxy-Original-URL', targetUrl);
      
      // コンテンツをクライアントに送信
      return res.send(body);
    }
  } catch (error) {
    console.error('プロキシエラー:', error.message);
    res.status(500).send(`
      <html>
        <head>
          <title>プロキシエラー</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background-color: #0f0f23;
              color: #cccccc;
              margin: 0;
              padding: 20px;
              line-height: 1.6;
            }
            .error-container {
              max-width: 800px;
              margin: 50px auto;
              background-color: #1a1a2e;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            h1 {
              color: #ff6b6b;
              margin-top: 0;
            }
            .message {
              background-color: rgba(255, 107, 107, 0.1);
              padding: 15px;
              border-left: 4px solid #ff6b6b;
              margin: 20px 0;
            }
            code {
              background: #2d2d4d;
              padding: 3px 5px;
              border-radius: 4px;
              font-family: monospace;
            }
            a {
              color: #00ccff;
              text-decoration: none;
            }
            a:hover {
              text-decoration: underline;
            }
            .back-button {
              display: inline-block;
              background-color: #00ccff;
              color: #0f0f23;
              padding: 10px 15px;
              border-radius: 4px;
              margin-top: 20px;
              font-weight: bold;
            }
            .back-button:hover {
              background-color: #33d6ff;
              text-decoration: none;
            }
          </style>
        </head>
        <body>
          <div class="error-container">
            <h1>プロキシエラー</h1>
            <div class="message">
              <p><strong>エラーメッセージ:</strong> ${error.message}</p>
              <p><strong>リクエストURL:</strong> <code>${targetUrl || '不明'}</code></p>
            </div>
            <p>このURLにアクセスできませんでした。以下が考えられる原因です:</p>
            <ul>
              <li>サーバーが応答していない</li>
              <li>URLが正しくない</li>
              <li>接続がタイムアウトした</li>
              <li>サイトがプロキシアクセスをブロックしている</li>
            </ul>
            <a href="/" class="back-button">ホームに戻る</a>
          </div>
        </body>
      </html>
    `);
  }
});

// POSTリクエストのプロキシ
app.post('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).json({ error: 'URLパラメータが必要です' });
  }
  
  try {
    const parsedUrl = new URL(targetUrl);
    
    // ヘッダーの準備
    const headers = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
      'Origin': getBaseUrl(targetUrl),
      'Referer': targetUrl
    };
    
    // Cookieを追加
    if (req.session.cookies && req.session.cookies[parsedUrl.hostname]) {
      headers['Cookie'] = req.session.cookies[parsedUrl.hostname];
    }
    
    const response = await axios({
      method: 'post',
      url: targetUrl,
      data: req.body,
      headers: headers,
      timeout: 15000,
      validateStatus: function (status) {
        return status < 500; // 4xxエラーも処理する
      }
    });
    
    // Cookieの保存
    if (response.headers['set-cookie']) {
      if (!req.session.cookies) {
        req.session.cookies = {};
      }
      req.session.cookies[parsedUrl.hostname] = response.headers['set-cookie'].join('; ');
    }
    
    // リダイレクト処理
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      let redirectUrl = response.headers.location;
      
      // 相対URLを絶対URLに変換
      if (isRelativePath(redirectUrl)) {
        redirectUrl = new URL(redirectUrl, targetUrl).href;
      } else if (redirectUrl.startsWith('//')) {
        redirectUrl = parsedUrl.protocol + redirectUrl;
      }
      
      // プロキシ経由でリダイレクト
      return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
    }
    
    // レスポンスヘッダーの転送（一部の問題になるヘッダーを除外）
    const excludeHeaders = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'host'];
    Object.keys(response.headers).forEach(header => {
      if (!excludeHeaders.includes(header.toLowerCase())) {
        res.setHeader(header, response.headers[header]);
      }
    });
    
    res.setHeader('X-Proxy-Original-URL', targetUrl);
    res.status(response.status).send(response.data);
  } catch (error) {
    console.error('POSTプロキシエラー:', error.message);
    res.status(500).json({ 
      error: 'POSTリクエストに失敗しました', 
      message: error.message,
      url: targetUrl
    });
  }
});

// 言語の検出
function getLanguageFromUrl(url) {
  const ext = path.extname(url).toLowerCase();
  const languageMap = {
    '.php': 'language-php',
    '.py': 'language-python',
    '.js': 'language-javascript',
    '.html': 'language-html',
    '.css': 'language-css',
    '.java': 'language-java',
    '.rb': 'language-ruby',
    '.cs': 'language-csharp',
    '.go': 'language-go',
    '.ts': 'language-typescript'
  };
  
  return languageMap[ext] || 'language-plaintext';
}

// サーバー起動
app.listen(PORT, () => {
  console.log(`拡張インターステラープロキシサーバーが起動しました: http://localhost:${PORT}`);
});