import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();
const proxy = httpProxy.createProxyServer({});

const PORT = 8080;

const DOH_SERVER =
    'https://cloudflare-dns.com/dns-query';


// ============================================================
// FIXED TARGET SITES
// ============================================================

const SITES = {
    wikipedia: {
        protocol: 'https:',
        hostname: 'wikipedia.org'
    },

    github: {
        protocol: 'https:',
        hostname: 'github.com'
    },

    example: {
        protocol: 'https:',
        hostname: 'example.com'
    }
};


// ============================================================
// DNS OVER HTTPS
// ============================================================

async function resolveDoH(hostname) {

    const url =
        `${DOH_SERVER}?name=${encodeURIComponent(hostname)}&type=A`;

    const response = await fetch(url, {
        headers: {
            'Accept': 'application/dns-json'
        }
    });

    if (!response.ok) {
        throw new Error(
            `DoH request failed: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (!data.Answer) {
        throw new Error(
            `No DNS answer for ${hostname}`
        );
    }

    const record = data.Answer.find(
        answer => answer.type === 1
    );

    if (!record) {
        throw new Error(
            `No IPv4 address found for ${hostname}`
        );
    }

    return record.data;
}


// ============================================================
// MAKE A LOCAL PROXY URL
//
// https://wikipedia.org/foo
//
// becomes:
//
// /portal/wikipedia.org/foo
//
// https://upload.wikimedia.org/a.png
//
// becomes:
//
// /portal/upload.wikimedia.org/a.png
// ============================================================

function makeLocalUrl(url) {

    try {

        const parsed = new URL(url);

        if (
            parsed.protocol !== 'http:' &&
            parsed.protocol !== 'https:'
        ) {
            return url;
        }

        let result =
            `/portal/${parsed.hostname}${parsed.pathname}`;

        if (parsed.search) {
            result += parsed.search;
        }

        if (parsed.hash) {
            result += parsed.hash;
        }

        return result;

    } catch {

        return url;

    }
}


// ============================================================
// REWRITE URLS INSIDE HTML
// ============================================================

function rewriteHtml(html) {

    // --------------------------------------------------------
    // Absolute URLs
    //
    // https://example.com/foo
    // https://upload.wikimedia.org/foo
    // --------------------------------------------------------

    html = html.replace(
        /https?:\/\/[^\s"'<>\\]+/gi,
        match => {

            return makeLocalUrl(match);

        }
    );


    // --------------------------------------------------------
    // Protocol-relative URLs
    //
    // //upload.wikimedia.org/foo
    // --------------------------------------------------------

    html = html.replace(
        /(["'(=])\/\/([^"'<>\\\s]+)/gi,
        (match, prefix, rest) => {

            const slashIndex =
                rest.indexOf('/');

            let hostname;
            let path;

            if (slashIndex === -1) {

                hostname = rest;
                path = '/';

            } else {

                hostname =
                    rest.substring(
                        0,
                        slashIndex
                    );

                path =
                    rest.substring(
                        slashIndex
                    );
            }

            return (
                `${prefix}/portal/` +
                `${hostname}${path}`
            );
        }
    );


    return html;
}


// ============================================================
// PARSE /portal/<hostname>/<path>
//
// Example:
//
// /portal/wikipedia.org/assets/foo.png
//
// hostname = wikipedia.org
// path     = /assets/foo.png
// ============================================================

function parsePortalUrl(url) {

    const match =
        url.match(
            /^\/portal\/([^/]+)(\/.*)?$/
        );

    if (!match) {
        return null;
    }

    return {
        hostname: match[1],
        path: match[2] || '/'
    };
}


// ============================================================
// PROXY ANY HOSTNAME
// ============================================================

async function proxyPortalRequest(
    req,
    res
) {

    const parsed =
        parsePortalUrl(req.originalUrl);

    if (!parsed) {

        res.status(400).send(
            'Invalid portal URL'
        );

        return;
    }


    const hostname =
        parsed.hostname;

    let targetPath =
        parsed.path;


    // Preserve query string
    if (req.originalUrl.includes('?')) {

        const query =
            req.originalUrl.substring(
                req.originalUrl.indexOf('?')
            );

        targetPath += query;
    }


    try {

        // ----------------------------------------------------
        // Resolve hostname through DoH
        // ----------------------------------------------------

        const ip =
            await resolveDoH(hostname);


        console.log(
            `[DNS] ${hostname} -> ${ip}`
        );


        req.url =
            targetPath;


        console.log(
            `[PROXY] ${req.method} ` +
            `${hostname}${targetPath}`
        );


        proxy.web(
            req,
            res,
            {

                target:
                    `https://${ip}`,

                changeOrigin: true,

                selfHandleResponse: true,

                headers: {

                    Host: hostname,

                    // We need uncompressed HTML
                    // so URLs can be rewritten.
                    'Accept-Encoding':
                        'identity'
                },

                agent:
                    new https.Agent({

                        // TLS SNI must contain
                        // the real hostname.
                        servername:
                            hostname
                    })
            }
        );

    } catch (error) {

        console.error(
            `[ERROR] ${hostname}: ` +
            `${error.message}`
        );

        if (!res.headersSent) {

            res.status(502).send(
                `Proxy error: ${error.message}`
            );
        }
    }
}


// ============================================================
// /portal/... ROUTE
// ============================================================

app.use(
    '/portal',
    async (req, res) => {

        await proxyPortalRequest(
            req,
            res
        );

    }
);


// ============================================================
// HANDLE PROXY RESPONSES
// ============================================================

proxy.on(
    'proxyRes',
    (proxyRes, req, res) => {

        const contentType =
            proxyRes.headers[
                'content-type'
            ] || '';


        // ====================================================
        // REDIRECTS
        // ====================================================

        const location =
            proxyRes.headers.location;


        if (location) {

            try {

                const currentHost =
                    req.originalUrl
                        .match(
                            /^\/portal\/([^/]+)/
                        )?.[1];


                const absolute =
                    new URL(
                        location,
                        `https://${currentHost}`
                    );


                proxyRes.headers.location =
                    makeLocalUrl(
                        absolute.href
                    );


                console.log(
                    `[REDIRECT] ${location}` +
                    ` -> ` +
                    `${proxyRes.headers.location}`
                );

            } catch {

                // Leave invalid Location headers alone.

            }
        }


        // ====================================================
        // HTML
        // ====================================================

        if (
            contentType.includes(
                'text/html'
            )
        ) {

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

                    let body =
                        Buffer
                            .concat(chunks)
                            .toString('utf8');


                    body =
                        rewriteHtml(body);


                    // Body length changed.
                    delete proxyRes.headers[
                        'content-length'
                    ];


                    res.writeHead(
                        proxyRes.statusCode || 200,
                        proxyRes.headers
                    );


                    res.end(body);

                }
            );


            return;
        }


        // ====================================================
        // EVERYTHING ELSE
        // ====================================================

        res.writeHead(
            proxyRes.statusCode || 200,
            proxyRes.headers
        );


        proxyRes.pipe(res);

    }
);


// ============================================================
// PROXY ERRORS
// ============================================================

proxy.on(
    'error',
    (error, req, res) => {

        console.error(
            `[PROXY ERROR] ${error.message}`
        );


        if (!res.headersSent) {

            res.writeHead(
                502,
                {
                    'Content-Type':
                        'text/plain'
                }
            );
        }


        res.end(
            `Proxy connection failed: ` +
            `${error.message}`
        );

    }
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
            '================================'
        );
        console.log(
            ' Fixed DoH Portal Proxy'
        );
        console.log(
            '================================'
        );
        console.log('');

        console.log(
            `Listening on http://localhost:${PORT}`
        );

        console.log('');
        console.log('Fixed sites:');

        for (
            const name of Object.keys(SITES)
        ) {

            console.log(
                `  http://localhost:${PORT}/portal/` +
                `${SITES[name].hostname}/`
            );

        }

        console.log('');
        console.log(
            `DNS: ${DOH_SERVER}`
        );

        console.log('');
    }
);