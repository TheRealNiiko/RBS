import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();
const proxy = httpProxy.createProxyServer({});

const PORT = 8080;

const DOH_SERVER =
    'https://cloudflare-dns.com/dns-query';


// ============================================================
// FIXED SITES
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
// BUILD HOSTNAME ALIASES
//
// wikipedia
// wikipedia.org
// www.wikipedia.org
//
// all point to:
//
// /wikipedia
// ============================================================

const HOST_TO_SITE = {};

for (const [name, site] of Object.entries(SITES)) {

    // Short name
    HOST_TO_SITE[name] = name;

    // Normal hostname
    HOST_TO_SITE[
        site.hostname.toLowerCase()
    ] = name;

    // www hostname
    HOST_TO_SITE[
        `www.${site.hostname}`.toLowerCase()
    ] = name;
}


// ============================================================
// GET SHORT SITE NAME FROM A HOSTNAME
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

    const data =
        await response.json();

    if (!data.Answer) {

        throw new Error(
            `No DNS answer for ${hostname}`
        );
    }

    const record =
        data.Answer.find(
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
// REAL WEBSITE URL -> LOCAL PROXY URL
//
// https://wikipedia.org/wiki/Linux
// https://www.wikipedia.org/wiki/Linux
//
// both become:
//
// /wikipedia/wiki/Linux
//
// External domains:
//
// https://upload.wikimedia.org/foo.png
//
// becomes:
//
// /upload.wikimedia.org/foo.png
// ============================================================

function makeLocalUrl(url) {

    try {

        const parsed =
            new URL(url);

        if (
            parsed.protocol !== 'http:' &&
            parsed.protocol !== 'https:'
        ) {
            return url;
        }


        const shortName =
            getSiteName(
                parsed.hostname
            );


        let result;


        if (shortName) {

            result =
                `/${shortName}${parsed.pathname}`;

        } else {

            result =
                `/${parsed.hostname}${parsed.pathname}`;
        }


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
// REWRITE HTML
// ============================================================

function rewriteHtml(
    html,
    currentSite
) {

    // --------------------------------------------------------
    // ABSOLUTE HTTP/HTTPS URLS
    //
    // https://wikipedia.org/foo
    // https://www.wikipedia.org/foo
    //
    // both become:
    //
    // /wikipedia/foo
    // --------------------------------------------------------

    html =
        html.replace(
            /https?:\/\/[^\s"'<>\\]+/gi,
            match => {

                return makeLocalUrl(
                    match
                );

            }
        );


    // --------------------------------------------------------
    // PROTOCOL-RELATIVE URLS
    //
    // //www.wikipedia.org/foo
    //
    // becomes:
    //
    // /wikipedia/foo
    // --------------------------------------------------------

    html =
        html.replace(
            /(["'(=])\/\/([^"'<>\\\s]+)/gi,
            (
                match,
                prefix,
                rest
            ) => {

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


                const shortName =
                    getSiteName(
                        hostname
                    );


                if (shortName) {

                    return (
                        `${prefix}/${shortName}${path}`
                    );
                }


                return (
                    `${prefix}/${hostname}${path}`
                );
            }
        );


    // --------------------------------------------------------
    // ROOT-RELATIVE URLS
    //
    // Example:
    //
    // <a href="/wiki/Linux">
    //
    // becomes:
    //
    // <a href="/wikipedia/wiki/Linux">
    //
    // This only applies while we're inside a fixed site.
    // --------------------------------------------------------

    if (currentSite) {

        html =
            html.replace(
                /(\b(?:href|src|action|poster|data-src)\s*=\s*["'])\/(?!\/)([^"']*)/gi,
                (
                    match,
                    prefix,
                    path
                ) => {

                    // Already local
                    if (
                        path === currentSite ||
                        path.startsWith(
                            `${currentSite}/`
                        )
                    ) {
                        return match;
                    }


                    return (
                        `${prefix}/${currentSite}/${path}`
                    );
                }
            );
    }


    // --------------------------------------------------------
    // CSS url(/foo.png)
    // --------------------------------------------------------

    if (currentSite) {

        html =
            html.replace(
                /url\(\s*\/(?!\/)([^)'"]+)\s*\)/gi,
                (
                    match,
                    path
                ) => {

                    return (
                        `url(/${currentSite}/${path})`
                    );
                }
            );
    }


    return html;
}


// ============================================================
// PARSE PROXY URL
//
// /wikipedia
// /wikipedia/
//
// /wikipedia/wiki/Linux
//
// /upload.wikimedia.org/foo.png
// ============================================================

function parseProxyUrl(url) {

    const parsed =
        new URL(
            url,
            'http://proxy.local'
        );


    const parts =
        parsed.pathname
            .split('/')
            .filter(Boolean);


    if (parts.length === 0) {
        return null;
    }


    const first =
        parts[0];


    // ========================================================
    // FIXED SITE
    // ========================================================

    if (SITES[first]) {

        const site =
            SITES[first];


        let path =
            '/' +
            parts
                .slice(1)
                .join('/');


        if (!path) {
            path = '/';
        }


        if (parsed.search) {
            path += parsed.search;
        }


        return {
            siteName: first,
            hostname: site.hostname,
            protocol: site.protocol,
            path
        };
    }


    // ========================================================
    // EXTERNAL HOSTNAME
    // ========================================================

    const hostname =
        first;


    let path =
        '/' +
        parts
            .slice(1)
            .join('/');


    if (!path) {
        path = '/';
    }


    if (parsed.search) {
        path += parsed.search;
    }


    return {
        siteName:
            getSiteName(hostname),

        hostname,

        protocol:
            'https:',

        path
    };
}


// ============================================================
// PROXY REQUEST
// ============================================================

async function proxyRequest(
    req,
    res
) {

    const parsed =
        parseProxyUrl(
            req.originalUrl
        );


    // ========================================================
    // HOME PAGE
    // ========================================================

    if (!parsed) {

        res.type('html').send(`

<!DOCTYPE html>

<html>

<head>
    <title>Fixed DoH Proxy</title>
</head>

<body>

    <h1>Fixed DoH Proxy</h1>

    <ul>

        ${Object.entries(SITES)
            .map(
                ([name, site]) => `
                    <li>
                        <a href="/${name}">
                            /${name}
                        </a>

                        →
                        ${site.hostname}
                    </li>
                `
            )
            .join('')}

    </ul>

</body>

</html>

        `);

        return;
    }


    const hostname =
        parsed.hostname;


    try {

        // ====================================================
        // DNS OVER HTTPS
        // ====================================================

        const ip =
            await resolveDoH(
                hostname
            );


        console.log(
            `[DNS] ${hostname} -> ${ip}`
        );


        // ====================================================
        // TARGET PATH
        // ====================================================

        req.url =
            parsed.path;


        console.log(
            `[PROXY] ${req.method} ` +
            `${hostname}${parsed.path}`
        );


        // ====================================================
        // PROXY
        // ====================================================

        proxy.web(
            req,
            res,
            {

                target:
                    `https://${ip}`,

                changeOrigin:
                    true,

                selfHandleResponse:
                    true,

                headers: {

                    Host:
                        hostname,

                    'Accept-Encoding':
                        'identity'
                },

                agent:
                    new https.Agent({

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
// ALL REQUESTS
// ============================================================

app.use(
    '/',
    async (
        req,
        res
    ) => {

        await proxyRequest(
            req,
            res
        );

    }
);


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

        const parsed =
            parseProxyUrl(
                req.originalUrl
            );


        if (!parsed) {

            res.writeHead(400);
            res.end();

            return;
        }


        const currentSite =
            parsed.siteName;


        // ====================================================
        // REDIRECTS
        // ====================================================

        const location =
            proxyRes
                .headers
                .location;


        if (location) {

            try {

                const absolute =
                    new URL(
                        location,
                        `${parsed.protocol}//${parsed.hostname}`
                    );


                const localLocation =
                    makeLocalUrl(
                        absolute.href
                    );


                proxyRes
                    .headers
                    .location =
                        localLocation;


                console.log(
                    `[REDIRECT] ${location}` +
                    ` -> ` +
                    `${localLocation}`
                );

            } catch {

                // Leave malformed redirects alone.
            }
        }


        // ====================================================
        // CONTENT TYPE
        // ====================================================

        const contentType =
            proxyRes
                .headers[
                    'content-type'
                ] || '';


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

                    chunks.push(
                        chunk
                    );

                }
            );


            proxyRes.on(
                'end',
                () => {

                    let body =
                        Buffer
                            .concat(
                                chunks
                            )
                            .toString(
                                'utf8'
                            );


                    body =
                        rewriteHtml(
                            body,
                            currentSite
                        );


                    // The HTML size changed.
                    delete proxyRes
                        .headers[
                            'content-length'
                        ];


                    // We requested identity encoding.
                    delete proxyRes
                        .headers[
                            'content-encoding'
                        ];


                    res.writeHead(
                        proxyRes.statusCode ||
                        200,

                        proxyRes.headers
                    );


                    res.end(
                        body
                    );

                }
            );


            return;
        }


        // ====================================================
        // EVERYTHING ELSE
        // ====================================================

        res.writeHead(
            proxyRes.statusCode ||
            200,

            proxyRes.headers
        );


        proxyRes.pipe(
            res
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
            `[PROXY ERROR] ` +
            `${error.message}`
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
            ' Fixed DoH Reverse Proxy'
        );
        console.log(
            '================================'
        );
        console.log('');

        console.log(
            `Listening on ` +
            `http://localhost:${PORT}`
        );

        console.log('');
        console.log(
            'Sites:'
        );


        for (
            const [
                name,
                site
            ]
            of Object.entries(SITES)
        ) {

            console.log(
                `  /${name}` +
                ` -> ${site.hostname}`
            );
        }


        console.log('');
        console.log(
            `DNS: ${DOH_SERVER}`
        );

        console.log('');
    }
);