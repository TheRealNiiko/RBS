import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();

const PORT = 8080;
const DOH_SERVER = 'https://cloudflare-dns.com/dns-query';

const SITES = {
    wikipedia: {
        protocol: 'https:',
        hostname: 'www.wikipedia.org'
    },

    github: {
        protocol: 'https:',
        hostname: 'github.com'
    },

    example: {
        protocol: 'https:',
        hostname: 'example.com'
    },

    pin: {
        protocol: 'https:',
        hostname: 'www.pinterest.com'
    }
};

const HOST_TO_SITE = {};

for (const [name, site] of Object.entries(SITES)) {
    HOST_TO_SITE[name] = name;

    const hostname = site.hostname.toLowerCase();

    HOST_TO_SITE[hostname] = name;

    if (!hostname.startsWith('www.')) {
        HOST_TO_SITE[`www.${hostname}`] = name;
    }
}

const proxy = httpProxy.createProxyServer({
    changeOrigin: true
});


/* =========================================================
   HOSTNAME VALIDATION
   ========================================================= */

function isValidHostname(hostname) {
    if (!hostname) {
        return false;
    }

    hostname = hostname.toLowerCase();

    if (hostname === 'localhost') {
        return true;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
        return true;
    }

    if (!hostname.includes('.')) {
        return false;
    }

    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
        return false;
    }

    if (
        hostname.startsWith('.') ||
        hostname.endsWith('.') ||
        hostname.includes('..')
    ) {
        return false;
    }

    return true;
}


/* =========================================================
   SITE LOOKUP
   ========================================================= */

function getSiteName(hostname) {
    hostname = hostname.toLowerCase();

    return HOST_TO_SITE[hostname] || null;
}


/* =========================================================
   DOH
   ========================================================= */

async function resolveDoH(hostname) {
    hostname = hostname.toLowerCase();

    if (!isValidHostname(hostname)) {
        throw new Error(
            `Invalid hostname: ${hostname}`
        );
    }

    const url =
        `${DOH_SERVER}?name=${encodeURIComponent(hostname)}&type=A`;

    const response =
        await fetch(
            url,
            {
                headers: {
                    'Accept': 'application/dns-json'
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            `DoH request failed: ${response.status} ${response.statusText}`
        );
    }

    const data =
        await response.json();

    const answer =
        data.Answer?.find(
            record => record.type === 1
        );

    if (!answer) {
        throw new Error(
            `No A record found for ${hostname}`
        );
    }

    return answer.data;
}


/* =========================================================
   LOCAL URL CONVERSION
   ========================================================= */

function makeLocalUrl(url) {
    try {
        const parsed =
            new URL(url);

        const hostname =
            parsed.hostname.toLowerCase();

        const siteName =
            getSiteName(hostname);

        if (siteName) {
            return (
                `/${siteName}` +
                `${parsed.pathname || '/'}` +
                `${parsed.search || ''}` +
                `${parsed.hash || ''}`
            );
        }

        if (!isValidHostname(hostname)) {
            return url;
        }

        return (
            `/${hostname}` +
            `${parsed.pathname || '/'}` +
            `${parsed.search || ''}` +
            `${parsed.hash || ''}`
        );
    } catch {
        return url;
    }
}


/* =========================================================
   URL REWRITING
   ========================================================= */

function rewriteUrl(url, currentSite) {
    if (!url) {
        return url;
    }

    url = url.trim();

    if (url.startsWith('#')) {
        return url;
    }

    if (
        url.startsWith('data:') ||
        url.startsWith('javascript:') ||
        url.startsWith('mailto:') ||
        url.startsWith('tel:') ||
        url.startsWith('blob:')
    ) {
        return url;
    }

    if (url.startsWith('//')) {
        return makeLocalUrl(`https:${url}`);
    }

    if (
        url.startsWith('http://') ||
        url.startsWith('https://')
    ) {
        return makeLocalUrl(url);
    }

    if (url.startsWith('/')) {
        return `/${currentSite}${url}`;
    }

    return url;
}


function rewriteHtml(html, currentSite) {

    html = html.replace(
        /(\b(?:href|src|action|poster|data-src|data-href)\s*=\s*)(["'])(.*?)\2/gi,
        (match, prefix, quote, url) => {
            return (
                prefix +
                quote +
                rewriteUrl(
                    url,
                    currentSite
                ) +
                quote
            );
        }
    );


    html = html.replace(
        /(\bcontent\s*=\s*)(["'])(.*?)\2/gi,
        (match, prefix, quote, value) => {
            return (
                prefix +
                quote +
                rewriteUrl(
                    value,
                    currentSite
                ) +
                quote
            );
        }
    );


    html = html.replace(
        /(\bsrcset\s*=\s*)(["'])(.*?)\2/gi,
        (match, prefix, quote, value) => {

            const rewritten =
                value
                    .split(',')
                    .map(part => {

                        const pieces =
                            part
                                .trim()
                                .split(/\s+/);

                        if (!pieces.length) {
                            return part;
                        }

                        pieces[0] =
                            rewriteUrl(
                                pieces[0],
                                currentSite
                            );

                        return pieces.join(' ');
                    })
                    .join(', ');

            return (
                prefix +
                quote +
                rewritten +
                quote
            );
        }
    );


    html = html.replace(
        /url\(\s*(["']?)(.*?)\1\s*\)/gi,
        (match, quote, url) => {

            if (!url) {
                return match;
            }

            const rewritten =
                rewriteUrl(
                    url,
                    currentSite
                );

            return (
                `url(${quote}${rewritten}${quote})`
            );
        }
    );


    html = html.replace(
        /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>\\)]*)?/gi,
        url => {
            return makeLocalUrl(url);
        }
    );


    html = html.replace(
        /(^|["'\s(])\/\/([A-Za-z0-9.-]+)(\/[^"'()\s<>]*)?/g,
        (
            match,
            prefix,
            hostname,
            path = '/'
        ) => {

            if (!isValidHostname(hostname)) {
                return match;
            }

            const fullUrl =
                `https://${hostname}${path}`;

            return (
                prefix +
                makeLocalUrl(fullUrl)
            );
        }
    );

    return html;
}


/* =========================================================
   EXPLICIT PROXY URL
   ========================================================= */

function parseExplicitSiteUrl(url) {

    const parsed =
        new URL(
            `http://proxy.local${url}`
        );

    const parts =
        parsed.pathname
            .split('/')
            .filter(Boolean);

    if (!parts.length) {
        return null;
    }

    const first =
        parts[0].toLowerCase();


    /*
     * Fixed sites:
     *
     * /pin/...
     * /github/...
     * /wikipedia/...
     */

    if (SITES[first]) {

        const site =
            SITES[first];

        const remainingPath =
            '/' +
            parts
                .slice(1)
                .join('/');

        return {

            siteName:
                first,

            protocol:
                site.protocol,

            hostname:
                site.hostname,

            path:
                remainingPath === '/'
                    ? '/'
                    : remainingPath,

            search:
                parsed.search
        };
    }


    /*
     * Explicit external hostname:
     *
     * /s2.pinimg.com/...
     */

    const hostname =
        first;

    if (!isValidHostname(hostname)) {
        return null;
    }

    const remainingPath =
        '/' +
        parts
            .slice(1)
            .join('/');

    return {

        siteName:
            getSiteName(hostname),

        protocol:
            'https:',

        hostname:
            hostname,

        path:
            remainingPath === '/'
                ? '/'
                : remainingPath,

        search:
            parsed.search
    };
}


/* =========================================================
   SERVICE WORKER
   ========================================================= */

const SERVICE_WORKER = `

const FIXED_SITES = {
    wikipedia: "wikipedia",
    github: "github",
    example: "example",
    pin: "pin"
};

self.addEventListener(
    "install",
    event => {
        self.skipWaiting();
    }
);

self.addEventListener(
    "activate",
    event => {
        event.waitUntil(
            self.clients.claim()
        );
    }
);

self.addEventListener(
    "fetch",
    event => {

        const request =
            event.request;

        const url =
            new URL(request.url);


        /*
         * Only handle requests belonging
         * to this proxy origin.
         */

        if (
            url.origin !== self.location.origin
        ) {
            return;
        }


        /*
         * Never intercept the service
         * worker itself.
         */

        if (
            url.pathname === "/__proxy_sw.js"
        ) {
            return;
        }


        /*
         * Requests that already have an
         * explicit site are allowed through.
         *
         * Example:
         *
         * /pin/foo
         * /github/foo
         */

        const first =
            url.pathname
                .split("/")
                .filter(Boolean)[0]
                ?.toLowerCase();


        if (
            first &&
            (
                FIXED_SITES[first] ||
                first.includes(".")
            )
        ) {
            return;
        }


        /*
         * Find the browser tab/client
         * that generated this request.
         */

        event.respondWith(
            (async () => {

                const client =
                    await self.clients.get(
                        event.clientId
                    );


                if (!client) {
                    return fetch(request);
                }


                const clientUrl =
                    new URL(
                        client.url
                    );


                const clientParts =
                    clientUrl.pathname
                        .split("/")
                        .filter(Boolean);


                const siteName =
                    clientParts[0]
                        ?.toLowerCase();


                /*
                 * The current browser page
                 * must belong to one of our
                 * fixed sites.
                 */

                if (
                    !siteName ||
                    !FIXED_SITES[siteName]
                ) {
                    return fetch(request);
                }


                /*
                 * Turn:
                 *
                 * /_/_/trace/trace/
                 *
                 * into:
                 *
                 * /pin/_/_/trace/trace/
                 *
                 * for a Pinterest tab.
                 */

                const rewritten =
                    new URL(
                        "/" +
                        siteName +
                        url.pathname +
                        url.search,
                        url.origin
                    );


                /*
                 * Tell the service worker that
                 * this request has already been
                 * routed, so it doesn't recurse.
                 */

                const headers =
                    new Headers(
                        request.headers
                    );

                headers.set(
                    "X-Proxy-Routed",
                    "1"
                );


                const routedRequest =
                    new Request(
                        rewritten,
                        {
                            method:
                                request.method,

                            headers:
                                headers,

                            body:
                                (
                                    request.method !== "GET" &&
                                    request.method !== "HEAD"
                                )
                                    ? request.body
                                    : undefined,

                            mode:
                                request.mode,

                            credentials:
                                request.credentials,

                            cache:
                                request.cache,

                            redirect:
                                request.redirect,

                            referrer:
                                request.referrer,

                            referrerPolicy:
                                request.referrerPolicy,

                            integrity:
                                request.integrity,

                            keepalive:
                                request.keepalive
                        }
                    );


                return fetch(
                    routedRequest
                );

            })()
        );
    }
);
`;


/* =========================================================
   SERVICE WORKER ENDPOINT
   ========================================================= */

app.get(
    '/__proxy_sw.js',
    (req, res) => {

        res.setHeader(
            'Content-Type',
            'application/javascript'
        );

        res.setHeader(
            'Cache-Control',
            'no-store'
        );

        res.setHeader(
            'Service-Worker-Allowed',
            '/'
        );

        res.send(
            SERVICE_WORKER
        );
    }
);


/* =========================================================
   SERVICE WORKER REGISTRATION
   ========================================================= */

function injectServiceWorker(html) {

    const registrationScript = `
<script>
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(
        '/__proxy_sw.js',
        {
            scope: '/'
        }
    ).catch(error => {
        console.error(
            '[Proxy] Service worker registration failed:',
            error
        );
    });
}
</script>
`;


if (
    /<\/head>/i.test(html)
) {

    return html.replace(
        /<\/head>/i,
        registrationScript +
        '</head>'
    );
}


    return (
        registrationScript +
        html
    );
}


/* =========================================================
   MAIN PROXY
   ========================================================= */

function proxyRequest(req, res) {

    /*
     * If the request was generated by the
     * service worker, it has already been
     * transformed into:
     *
     * /pin/...
     *
     * so normal parsing handles it.
     */


    if (
        req.path === '/' ||
        req.path === ''
    ) {

        const links =
            Object.keys(SITES)
                .map(name => {

                    return `
                        <li>
                            <a href="/${name}/">
                                /${name}/
                            </a>
                        </li>
                    `;

                })
                .join('\n');


        res.send(`
            <!DOCTYPE html>

            <html>

            <head>

                <meta charset="UTF-8">

                <title>
                    Fixed DoH Proxy
                </title>

            </head>

            <body>

                <h1>
                    Fixed DoH Reverse Proxy
                </h1>

                <ul>
                    ${links}
                </ul>

            </body>

            </html>
        `);

        return;
    }


    let parsed;

    try {

        parsed =
            parseExplicitSiteUrl(
                req.url
            );

    } catch (error) {

        res.status(400).send(
            `Invalid proxy URL: ${error.message}`
        );

        return;
    }


    if (!parsed) {

        res.status(404).send(
            'Unknown or invalid proxy path'
        );

        return;
    }


    const {
        hostname,
        protocol,
        path,
        search
    } = parsed;


    resolveDoH(hostname)

        .then(ip => {

            console.log(
                `[DNS] ${hostname} -> ${ip}`
            );

            console.log(
                `[PROXY] ${req.method} ${hostname}${path}${search}`
            );


            req.url =
                path +
                search;


            const agent =
                new https.Agent({
                    servername:
                        hostname
                });


            proxy.web(
                req,
                res,
                {

                    target:
                        `${protocol}//${ip}`,

                    changeOrigin:
                        true,

                    selfHandleResponse:
                        true,

                    agent,

                    headers: {

                        Host:
                            hostname,

                        'Accept-Encoding':
                            'identity'
                    }
                }
            );

        })

        .catch(error => {

            console.error(
                `[ERROR] ${hostname}:`,
                error.message
            );

            if (!res.headersSent) {

                res.status(502).send(
                    `DNS/proxy error: ${error.message}`
                );
            }
        });
}


/* =========================================================
   PROXY RESPONSE
   ========================================================= */

proxy.on(
    'proxyRes',

    (
        proxyRes,
        req,
        res
    ) => {

        const chunks = [];


        proxyRes.on(
            'data',
            chunk => {
                chunks.push(chunk);
            }
        );


        proxyRes.on(
            'end',

            () => {

                const body =
                    Buffer.concat(
                        chunks
                    );


                const contentType =
                    proxyRes.headers[
                        'content-type'
                    ] || '';


                let currentSite =
                    null;


                try {

                    const parsed =
                        parseExplicitSiteUrl(
                            req.originalUrl ||
                            req.url
                        );

                    currentSite =
                        parsed?.siteName ||
                        null;

                } catch {
                    currentSite =
                        null;
                }


                /*
                 * Rewrite redirects.
                 */

                if (
                    proxyRes.headers.location
                ) {

                    const location =
                        proxyRes.headers.location;


                    const rewrittenLocation =
                        makeLocalUrl(
                            location
                        );


                    if (
                        rewrittenLocation ===
                        req.originalUrl
                    ) {

                        delete proxyRes
                            .headers
                            .location;

                    } else {

                        proxyRes
                            .headers
                            .location =
                                rewrittenLocation;
                    }
                }


                /*
                 * HTML
                 */

                if (
                    contentType
                        .toLowerCase()
                        .includes(
                            'text/html'
                        )
                ) {

                    delete proxyRes
                        .headers[
                            'content-security-policy'
                        ];

                    delete proxyRes
                        .headers[
                            'content-security-policy-report-only'
                        ];

                    delete proxyRes
                        .headers[
                            'x-frame-options'
                        ];


                    let html =
                        body.toString(
                            'utf8'
                        );


                    if (
                        currentSite
                    ) {

                        html =
                            rewriteHtml(
                                html,
                                currentSite
                            );
                    }


                    /*
                     * Install the service worker
                     * registration into the page.
                     */

                    html =
                        injectServiceWorker(
                            html
                        );


                    delete proxyRes
                        .headers[
                            'content-length'
                        ];

                    delete proxyRes
                        .headers[
                            'content-encoding'
                        ];


                    res.writeHead(
                        proxyRes.statusCode,
                        proxyRes.headers
                    );


                    res.end(
                        html
                    );

                    return;
                }


                /*
                 * Non-HTML response.
                 */

                res.writeHead(
                    proxyRes.statusCode,
                    proxyRes.headers
                );


                res.end(
                    body
                );
            }
        );
    }
);


/* =========================================================
   PROXY ERROR
   ========================================================= */

proxy.on(
    'error',

    (
        error,
        req,
        res
    ) => {

        console.error(
            `[PROXY ERROR] ${error.message}`
        );


        if (!res.headersSent) {

            res.statusCode =
                502;

            res.end(
                `Proxy error: ${error.message}`
            );
        }
    }
);


/* =========================================================
   EXPRESS
   ========================================================= */

app.use(
    '/',
    proxyRequest
);


/* =========================================================
   START
   ========================================================= */

app.listen(
    PORT,
    '127.0.0.1',

    () => {

        console.log('');

        console.log(
            '================================='
        );

        console.log(
            ' Fixed DoH Reverse Proxy'
        );

        console.log(
            '================================='
        );

        console.log('');

        console.log(
            `Listening on http://localhost:${PORT}`
        );

        console.log('');

        console.log(
            'Sites:'
        );


        for (
            const name of Object.keys(SITES)
        ) {

            console.log(
                `  http://localhost:${PORT}/${name}/`
            );
        }


        console.log('');

        console.log(
            `DNS: ${DOH_SERVER}`
        );

        console.log('');
    }
);