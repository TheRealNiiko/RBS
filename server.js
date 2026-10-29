import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();

const PORT = 8080;
const DOH_SERVER = 'https://cloudflare-dns.com/dns-query';


/*
 * ============================================
 * FIXED SITES
 * ============================================
 */

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

    chess: {
        protocol: 'https:',
        hostname: 'ches.com'
    }
};


/*
 * ============================================
 * HOSTNAME -> SITE NAME
 * ============================================
 */

const HOST_TO_SITE = {};

for (const [name, site] of Object.entries(SITES)) {

    HOST_TO_SITE[name] = name;

    const hostname = site.hostname.toLowerCase();

    HOST_TO_SITE[hostname] = name;

    if (!hostname.startsWith('www.')) {
        HOST_TO_SITE[`www.${hostname}`] = name;
    }
}


/*
 * ============================================
 * PINTEREST ROOT-LEVEL INTERNAL PATHS
 * ============================================
 *
 * Pinterest can make requests such as:
 *
 *     /_/_/storage_report/
 *     /_/graphql/
 *     /resource/...
 *     /secure/...
 *
 * These paths don't contain /pin/.
 *
 * We route them to Pinterest server-side.
 */

const PINTEREST_ROOT_PREFIXES = [
    '/resource/',
    '/secure/',
    '/_/',
    '/_/_/'
];


/*
 * ============================================
 * PROXY
 * ============================================
 */

const proxy = httpProxy.createProxyServer({
    changeOrigin: true
});


/*
 * ============================================
 * HOSTNAME VALIDATION
 * ============================================
 */

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


/*
 * ============================================
 * GET SITE NAME
 * ============================================
 */

function getSiteName(hostname) {

    hostname = hostname.toLowerCase();

    return HOST_TO_SITE[hostname] || null;
}


/*
 * ============================================
 * CHECK PINTEREST ROOT PATH
 * ============================================
 */

function isPinterestRootPath(pathname) {

    return PINTEREST_ROOT_PREFIXES.some(
        prefix => pathname.startsWith(prefix)
    );
}


/*
 * ============================================
 * CHECK WHETHER REQUEST CAME FROM /pin/
 * ============================================
 *
 * This is the important replacement for the
 * browser-side API shim.
 *
 * We leave Pinterest HTML untouched.
 *
 * If Pinterest JavaScript requests:
 *
 *     /_/graphql/
 *
 * the browser sends the Referer:
 *
 *     https://our-proxy.app.github.dev/pin/
 *
 * We can therefore determine that the request
 * belongs to Pinterest without modifying the
 * HTML or JavaScript.
 */

function requestCameFromPinterest(req) {

    const referer =
        req.headers.referer ||
        req.headers.referrer ||
        '';

    if (!referer) {
        return false;
    }

    try {

        const parsed =
            new URL(referer);

        return (
            parsed.pathname === '/pin' ||
            parsed.pathname.startsWith('/pin/')
        );

    } catch {

        return false;
    }
}


/*
 * ============================================
 * DNS OVER HTTPS
 * ============================================
 */

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
                    Accept: 'application/dns-json'
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


/*
 * ============================================
 * EXTERNAL URL -> LOCAL URL
 * ============================================
 */

function makeLocalUrl(url) {

    try {

        const parsed = new URL(url);

        const hostname =
            parsed.hostname.toLowerCase();

        const siteName =
            getSiteName(hostname);


        /*
         * Fixed site.
         */

        if (siteName) {

            return (
                `/${siteName}` +
                `${parsed.pathname || '/'}` +
                `${parsed.search || ''}` +
                `${parsed.hash || ''}`
            );
        }


        /*
         * External hostname.
         */

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


/*
 * ============================================
 * REWRITE HTML ATTRIBUTE URL
 * ============================================
 *
 * Used for sites other than Pinterest.
 *
 * Pinterest HTML is NOT passed through this.
 */

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

        return makeLocalUrl(
            `https:${url}`
        );
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


/*
 * ============================================
 * REMOVE CSP META TAGS
 * ============================================
 *
 * Only used for non-Pinterest HTML.
 *
 * Pinterest HTML remains completely untouched.
 */

function removeCspMetaTags(html) {

    return html.replace(
        /<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy(?:-Report-Only)?["'][^>]*>/gi,
        ''
    );
}


/*
 * ============================================
 * REWRITE HTML ATTRIBUTES
 * ============================================
 *
 * Used for non-Pinterest fixed sites.
 */

function rewriteHtmlAttributes(html, currentSite) {

    const protectedBlocks = [];


    /*
     * Protect script/style contents.
     */

    html = html.replace(
        /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,

        block => {

            const index =
                protectedBlocks.length;

            protectedBlocks.push(block);

            return (
                `___PROXY_PROTECTED_BLOCK_${index}___`
            );
        }
    );


    /*
     * href/src/action/etc.
     */

    html = html.replace(
        /(\b(?:href|src|action|poster|data-src|data-href)\s*=\s*)(["'])(.*?)\2/gi,

        (
            match,
            prefix,
            quote,
            url
        ) => {

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


    /*
     * srcset.
     */

    html = html.replace(
        /(\bsrcset\s*=\s*)(["'])(.*?)\2/gi,

        (
            match,
            prefix,
            quote,
            value
        ) => {

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


    /*
     * Restore protected blocks.
     */

    html = html.replace(
        /___PROXY_PROTECTED_BLOCK_(\d+)___/g,

        (
            match,
            index
        ) => {

            return protectedBlocks[
                Number(index)
            ];
        }
    );

    return html;
}


/*
 * ============================================
 * PARSE PROXY URL
 * ============================================
 */

function parseProxyUrl(url) {

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
     * Fixed site.
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

            siteName: first,

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
     * External hostname.
     */

    const hostname = first;

    if (!isValidHostname(hostname)) {
        return null;
    }

    const remainingPath =
        '/' +
        parts
            .slice(1)
            .join('/');

    return {

        siteName: null,

        protocol: 'https:',

        hostname,

        path:
            remainingPath === '/'
                ? '/'
                : remainingPath,

        search:
            parsed.search
    };
}


/*
 * ============================================
 * PROXY A REQUEST DIRECTLY
 * ============================================
 */

function sendToProxy(
    req,
    res,
    {
        hostname,
        protocol,
        path,
        search,
        siteName = null
    }
) {

    resolveDoH(hostname)

        .then(ip => {

            console.log(
                `[DNS] ${hostname} -> ${ip}`
            );

            console.log(
                `[PROXY] ${req.method} ${hostname}${path}${search}`
            );


            /*
             * This is the URL that the upstream
             * server actually receives.
             */

            req.url =
                path +
                search;


            /*
             * Tell proxyRes which site this
             * request belongs to.
             */

            req.proxySiteName =
                siteName;


            const agent =
                new https.Agent({
                    servername: hostname
                });


            proxy.web(
                req,
                res,
                {

                    target:
                        `${protocol}//${ip}`,

                    changeOrigin: true,

                    selfHandleResponse: true,

                    agent,

                    headers: {

                        Host: hostname,

                        /*
                         * Don't let upstream send
                         * compressed HTML.
                         */

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

                res
                    .status(502)
                    .send(
                        `DNS/proxy error: ${error.message}`
                    );
            }
        });
}


/*
 * ============================================
 * MAIN REQUEST HANDLER
 * ============================================
 */

function proxyRequest(req, res) {

    const pathname = req.path;


    /*
     * ========================================
     * ROOT PAGE
     * ========================================
     */

    if (
        pathname === '/' ||
        pathname === ''
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
                <title>Fixed DoH Proxy</title>
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


    /*
     * ========================================
     * PINTEREST ROOT-LEVEL REQUEST
     * ========================================
     *
     * Example:
     *
     *     /_/_/storage_report/
     *
     * is sent directly to:
     *
     *     www.pinterest.com/_/_/storage_report/
     *
     * without changing the browser's URL.
     */

    if (
        isPinterestRootPath(pathname)
    ) {

        console.log(
            `[PINTEREST ROOT] ${req.method} ${req.originalUrl}`
        );


        sendToProxy(
            req,
            res,
            {

                hostname:
                    SITES.pin.hostname,

                protocol:
                    SITES.pin.protocol,

                path:
                    pathname,

                search:
                    req.url.includes('?')
                        ? req.url.substring(
                            req.url.indexOf('?')
                        )
                        : '',

                siteName:
                    'pin'
            }
        );

        return;
    }


    /*
     * ========================================
     * PINTEREST ROOT-RELATIVE REQUEST
     * VIA REFERER
     * ========================================
     *
     * This is the important part.
     *
     * Pinterest HTML stays untouched.
     *
     * If JavaScript loaded from /pin/ asks for:
     *
     *     /some/api/path
     *
     * the Referer tells us the request came
     * from the Pinterest proxy page.
     */

    if (
        pathname !== '/' &&
        requestCameFromPinterest(req)
    ) {

        console.log(
            `[PINTEREST REFERER] ${req.method} ${req.originalUrl} <- ${req.headers.referer || req.headers.referrer}`
        );


        sendToProxy(
            req,
            res,
            {

                hostname:
                    SITES.pin.hostname,

                protocol:
                    SITES.pin.protocol,

                path:
                    pathname,

                search:
                    req.url.includes('?')
                        ? req.url.substring(
                            req.url.indexOf('?')
                        )
                        : '',

                siteName:
                    'pin'
            }
        );

        return;
    }


    /*
     * ========================================
     * NORMAL PROXY URL
     * ========================================
     */

    let parsed;

    try {

        parsed =
            parseProxyUrl(
                req.url
            );

    } catch (error) {

        res
            .status(400)
            .send(
                `Invalid proxy URL: ${error.message}`
            );

        return;
    }


    if (!parsed) {

        res
            .status(404)
            .send(
                'Unknown or invalid proxy path'
            );

        return;
    }


    sendToProxy(
        req,
        res,
        parsed
    );
}


/*
 * ============================================
 * PROXY RESPONSE
 * ============================================
 */

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
                    Buffer.concat(chunks);


                const contentType =
                    proxyRes
                        .headers[
                            'content-type'
                        ] || '';


                /*
                 * The site was explicitly recorded
                 * by sendToProxy().
                 */

                const currentSite =
                    req.proxySiteName || null;


                /*
                 * =================================
                 * LOCATION HEADER
                 * =================================
                 */

                if (
                    proxyRes
                        .headers
                        .location
                ) {

                    const location =
                        proxyRes
                            .headers
                            .location;

                    let rewrittenLocation;


                    if (
                        location.startsWith(
                            'http://'
                        ) ||
                        location.startsWith(
                            'https://'
                        )
                    ) {

                        rewrittenLocation =
                            makeLocalUrl(
                                location
                            );

                    } else if (
                        location.startsWith('//')
                    ) {

                        rewrittenLocation =
                            makeLocalUrl(
                                `https:${location}`
                            );

                    } else if (
                        location.startsWith('/') &&
                        currentSite
                    ) {

                        /*
                         * Don't double-prefix.
                         */

                        if (
                            location ===
                            '/' + currentSite ||

                            location.startsWith(
                                '/' +
                                currentSite +
                                '/'
                            )
                        ) {

                            rewrittenLocation =
                                location;

                        } else {

                            rewrittenLocation =
                                '/' +
                                currentSite +
                                location;
                        }

                    } else {

                        rewrittenLocation =
                            location;
                    }


                    /*
                     * Avoid redirecting a request
                     * back to itself.
                     */

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
                 * =================================
                 * PINTEREST HTML
                 * =================================
                 *
                 * IMPORTANT:
                 *
                 * Pinterest HTML is returned
                 * completely untouched.
                 *
                 * No:
                 *
                 *   - DOM rewriting
                 *   - script injection
                 *   - __PWS_DATA__ modification
                 *   - attribute rewriting
                 *
                 * This is specifically to avoid
                 * React hydration mismatches.
                 */

                if (
                    currentSite === 'pin' &&
                    contentType
                        .toLowerCase()
                        .includes('text/html')
                ) {

                    /*
                     * We can remove these response
                     * headers without touching the
                     * HTML body.
                     */

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


                    /*
                     * Body is sent EXACTLY as received.
                     */

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


                    res.end(body);

                    return;
                }


                /*
                 * =================================
                 * OTHER HTML
                 * =================================
                 *
                 * Wikipedia/GitHub/example can
                 * still use the old HTML rewriting
                 * behavior.
                 */

                if (
                    contentType
                        .toLowerCase()
                        .includes('text/html')
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
                        body.toString('utf8');


                    if (currentSite) {

                        html =
                            removeCspMetaTags(
                                html
                            );

                        html =
                            rewriteHtmlAttributes(
                                html,
                                currentSite
                            );
                    }


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


                    res.end(html);

                    return;
                }


                /*
                 * =================================
                 * NON-HTML
                 * =================================
                 */

                res.writeHead(
                    proxyRes.statusCode,
                    proxyRes.headers
                );


                res.end(body);
            }
        );
    }
);


/*
 * ============================================
 * PROXY ERROR
 * ============================================
 */

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

            res.statusCode = 502;

            res.end(
                `Proxy error: ${error.message}`
            );
        }
    }
);


/*
 * ============================================
 * EXPRESS
 * ============================================
 */

app.use(
    '/',
    proxyRequest
);


/*
 * ============================================
 * START SERVER
 * ============================================
 */

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
