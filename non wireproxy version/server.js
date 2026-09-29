import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();

const PORT = 8080;
const DOH_SERVER = 'https://cloudflare-dns.com/dns-query';


// ============================================================
// FIXED SITES
// ============================================================

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


// ============================================================
// HOSTNAME -> SHORT NAME
// ============================================================

const HOST_TO_SITE = {};

for (const [name, site] of Object.entries(SITES)) {
    HOST_TO_SITE[name] = name;

    const hostname = site.hostname.toLowerCase();

    HOST_TO_SITE[hostname] = name;

    if (!hostname.startsWith('www.')) {
        HOST_TO_SITE[`www.${hostname}`] = name;
    }
}


// ============================================================
// PROXY
// ============================================================

const proxy = httpProxy.createProxyServer({
    changeOrigin: true
});


// ============================================================
// VALIDATE HOSTNAME
// ============================================================

function isValidHostname(hostname) {

    if (!hostname) {
        return false;
    }

    hostname = hostname.toLowerCase();


    // Allow localhost
    if (hostname === 'localhost') {
        return true;
    }


    // Allow IPv4
    if (
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    ) {
        return true;
    }


    // Normal internet hostnames should contain a dot.
    //
    // This prevents things such as:
    //
    // _
    // resource
    // foo
    //
    // from being interpreted as external domains.

    if (!hostname.includes('.')) {
        return false;
    }


    // Hostname characters
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
        return false;
    }


    // Don't allow empty hostname labels
    if (
        hostname.startsWith('.') ||
        hostname.endsWith('.') ||
        hostname.includes('..')
    ) {
        return false;
    }


    return true;
}


// ============================================================
// FIND SHORT SITE NAME
// ============================================================

function getSiteName(hostname) {

    hostname =
        hostname.toLowerCase();

    return HOST_TO_SITE[hostname] || null;
}


// ============================================================
// DNS OVER HTTPS
// ============================================================

async function resolveDoH(hostname) {

    hostname =
        hostname.toLowerCase();


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


// ============================================================
// REAL URL -> LOCAL PROXY URL
// ============================================================

function makeLocalUrl(url) {

    try {

        const parsed =
            new URL(url);


        const hostname =
            parsed.hostname.toLowerCase();


        const siteName =
            getSiteName(hostname);


        // ----------------------------------------------------
        // FIXED SITE
        // ----------------------------------------------------

        if (siteName) {

            return (
                `/${siteName}` +
                `${parsed.pathname || '/'}` +
                `${parsed.search || ''}` +
                `${parsed.hash || ''}`
            );
        }


        // ----------------------------------------------------
        // EXTERNAL HOSTNAME
        // ----------------------------------------------------

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


// ============================================================
// REWRITE URL
// ============================================================

function rewriteUrl(url, currentSite) {

    if (!url) {
        return url;
    }


    url =
        url.trim();


    // Fragment
    if (url.startsWith('#')) {
        return url;
    }


    // Special schemes
    if (
        url.startsWith('data:') ||
        url.startsWith('javascript:') ||
        url.startsWith('mailto:') ||
        url.startsWith('tel:') ||
        url.startsWith('blob:')
    ) {
        return url;
    }


    // Protocol-relative URL
    if (url.startsWith('//')) {

        return makeLocalUrl(
            `https:${url}`
        );
    }


    // Absolute URL
    if (
        url.startsWith('http://') ||
        url.startsWith('https://')
    ) {

        return makeLocalUrl(url);
    }


    // Root-relative URL
    if (url.startsWith('/')) {

        return (
            `/${currentSite}${url}`
        );
    }


    // Relative URL
    //
    // Leave these alone because the browser can resolve
    // them relative to the current proxied path.

    return url;
}


// ============================================================
// REWRITE HTML
// ============================================================

function rewriteHtml(
    html,
    currentSite
) {


    // --------------------------------------------------------
    // NORMAL HTML ATTRIBUTES
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // META CONTENT URLS
    // --------------------------------------------------------

    html = html.replace(
        /(\bcontent\s*=\s*)(["'])(.*?)\2/gi,

        (
            match,
            prefix,
            quote,
            value
        ) => {

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


    // --------------------------------------------------------
    // SRCSET
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // CSS url(...)
    // --------------------------------------------------------

    html = html.replace(
        /url\(\s*(["']?)(.*?)\1\s*\)/gi,

        (
            match,
            quote,
            url
        ) => {

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


    // --------------------------------------------------------
    // ABSOLUTE URLS
    //
    // Only rewrite actual HTTP URLs.
    // This avoids treating arbitrary JavaScript strings
    // as hostnames.
    // --------------------------------------------------------

    html = html.replace(
        /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>\\)]*)?/gi,

        url => {

            return makeLocalUrl(url);
        }
    );


    // --------------------------------------------------------
    // PROTOCOL-RELATIVE URLS
    // --------------------------------------------------------

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


// ============================================================
// PARSE LOCAL PROXY URL
//
// /github/
// /github/foo/bar
//
// /wikipedia/
// /wikipedia/wiki/Test
//
// /s2.pinimg.com/webapp/foo.mjs
// ============================================================

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


    // --------------------------------------------------------
    // FIXED SITE
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // EXTERNAL HOSTNAME
    // --------------------------------------------------------

    const hostname =
        first;


    // Don't send invalid things such as
    // /resource/ or /_/ to DNS.

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
            null,

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


// ============================================================
// MAIN PROXY REQUEST
// ============================================================

function proxyRequest(
    req,
    res
) {


    // --------------------------------------------------------
    // HOME PAGE
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // PARSE URL
    // --------------------------------------------------------

    let parsed;


    try {

        parsed =
            parseProxyUrl(
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


    // --------------------------------------------------------
    // DNS
    // --------------------------------------------------------

    resolveDoH(hostname)

        .then(ip => {

            console.log(
                `[DNS] ${hostname} -> ${ip}`
            );


            console.log(
                `[PROXY] ${req.method} ${hostname}${path}${search}`
            );


            // ------------------------------------------------
            // PATH SENT UPSTREAM
            // ------------------------------------------------

            req.url =
                path +
                search;


            // ------------------------------------------------
            // TLS
            // ------------------------------------------------

            const agent =
                new https.Agent({

                    servername:
                        hostname
                });


            // ------------------------------------------------
            // PROXY REQUEST
            // ------------------------------------------------

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

                        // Prevent upstream compression
                        // so HTML can be rewritten.
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


// ============================================================
// PROXY RESPONSE
// ============================================================

proxy.on(
    'proxyRes',

    (
        proxyRes,
        req,
        res
    ) => {

        const chunks = [];


        // ----------------------------------------------------
        // COLLECT RESPONSE
        // ----------------------------------------------------

        proxyRes.on(
            'data',

            chunk => {
                chunks.push(chunk);
            }
        );


        // ----------------------------------------------------
        // RESPONSE COMPLETE
        // ----------------------------------------------------

        proxyRes.on(
            'end',

            () => {

                const body =
                    Buffer.concat(chunks);


                const contentType =
                    proxyRes.headers[
                        'content-type'
                    ] || '';


                // --------------------------------------------
                // CURRENT SITE
                // --------------------------------------------

                let currentSite =
                    null;


                try {

                    const parsed =
                        parseProxyUrl(
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


                // --------------------------------------------
                // REDIRECTS
                // --------------------------------------------

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


                // --------------------------------------------
                // HTML
                // --------------------------------------------

                if (
                    contentType
                        .toLowerCase()
                        .includes(
                            'text/html'
                        )
                ) {


                    // ----------------------------------------
                    // REMOVE CSP
                    // ----------------------------------------

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


                    // ----------------------------------------
                    // REWRITE HTML
                    // ----------------------------------------

                    let html =
                        body.toString(
                            'utf8'
                        );


                    if (currentSite) {

                        html =
                            rewriteHtml(
                                html,
                                currentSite
                            );
                    }


                    // ----------------------------------------
                    // HTML SIZE CHANGED
                    // ----------------------------------------

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


                // --------------------------------------------
                // NON-HTML
                //
                // CSS
                // JS
                // IMAGES
                // FONTS
                // JSON
                // ETC.
                // --------------------------------------------

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


// ============================================================
// PROXY ERRORS
// ============================================================

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


// ============================================================
// EXPRESS ROUTE
// ============================================================

app.use(
    '/',
    proxyRequest
);


// ============================================================
// START SERVER
// ============================================================

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