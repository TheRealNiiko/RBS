import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();
const proxy = httpProxy.createProxyServer({});

const PORT = 8080;

const DOH_SERVER =
    'https://cloudflare-dns.com/dns-query';


// ==========================================
// Fixed websites
// ==========================================

const SITES = {

    github: {
        protocol: 'https:',
        hostname: 'github.com'
    },

    wikipedia: {
        protocol: 'https:',
        hostname: 'www.wikipedia.org'
    },

    example: {
        protocol: 'https:',
        hostname: 'example.com'
    }

};


// ==========================================
// Encode / decode hostnames
// ==========================================
//
// Example:
//
// github.githubassets.com
//
// becomes:
//
// Z2l0aHViLmdpdGh1YmFzc2V0cy5jb20
//

function encodeHost(hostname) {
    return Buffer
        .from(hostname)
        .toString('base64url');
}

function decodeHost(encoded) {
    return Buffer
        .from(encoded, 'base64url')
        .toString('utf8');
}


// ==========================================
// DNS-over-HTTPS
// ==========================================

async function resolveDoH(hostname) {

    const url =
        `${DOH_SERVER}?name=${encodeURIComponent(hostname)}&type=A`;

    const response = await fetch(url, {
        headers: {
            Accept: 'application/dns-json'
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


// ==========================================
// Convert external URL → local URL
// ==========================================

function localizeUrl(url, siteName) {

    try {

        const parsed = new URL(url);

        if (
            parsed.protocol !== 'http:' &&
            parsed.protocol !== 'https:'
        ) {
            return url;
        }

        const encodedHost =
            encodeHost(parsed.hostname);

        let result =
            `/${siteName}/_external/` +
            `${encodedHost}`;

        result += parsed.pathname;

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


// ==========================================
// Rewrite URLs inside HTML
// ==========================================

function rewriteHtml(
    html,
    siteName,
    originalHostname
) {

    // --------------------------------------
    // Absolute URLs
    // --------------------------------------

    html = html.replace(
        /https?:\/\/[^\s"'<>\\]+/gi,
        match => {

            return localizeUrl(
                match,
                siteName
            );

        }
    );


    // --------------------------------------
    // Protocol-relative URLs
    //
    // //example.com/image.png
    // --------------------------------------

    html = html.replace(
        /(["'(=])\/\/([^"'<>\\\s]+)/gi,
        (match, prefix, rest) => {

            return `${prefix}/` +
                `${siteName}/_external/` +
                `${encodeHost(rest.split('/')[0])}` +
                `/${rest.split('/').slice(1).join('/')}`;

        }
    );


    return html;
}


// ==========================================
// Proxy an external domain
// ==========================================

async function proxyExternal(
    req,
    res,
    siteName,
    encodedHost
) {

    let hostname;

    try {
        hostname = decodeHost(encodedHost);
    } catch {
        res.status(400).send(
            'Invalid hostname'
        );
        return;
    }


    // Basic hostname validation
    if (
        !hostname ||
        hostname.includes('/') ||
        hostname.includes('\\') ||
        hostname.includes('..')
    ) {
        res.status(400).send(
            'Invalid hostname'
        );
        return;
    }


    try {

        const ip =
            await resolveDoH(hostname);

        console.log(
            `[DNS] ${hostname} -> ${ip}`
        );


        // /site/_external/encoded/path
        const prefix =
            `/${siteName}/_external/${encodedHost}`;

        let targetPath =
            req.originalUrl
                .substring(prefix.length);

        if (!targetPath) {
            targetPath = '/';
        }


        req.url = targetPath;


        console.log(
            `[EXTERNAL] ${hostname}${targetPath}`
        );


        proxy.web(req, res, {

            target: `https://${ip}`,

            changeOrigin: true,

            selfHandleResponse: true,

            headers: {

                Host: hostname,

                'Accept-Encoding': 'identity'

            },

            agent: new https.Agent({

                servername: hostname

            })

        });

    } catch (error) {

        console.error(
            `[EXTERNAL ERROR] ${error.message}`
        );

        if (!res.headersSent) {
            res.status(502).send(
                `External proxy error: ${error.message}`
            );
        }
    }
}


// ==========================================
// External domain route
// ==========================================

app.use(
    '/:site/_external/:host',
    async (req, res) => {

        const siteName =
            req.params.site;

        if (!SITES[siteName]) {

            res.status(404).send(
                'Unknown site'
            );

            return;
        }

        await proxyExternal(
            req,
            res,
            siteName,
            req.params.host
        );
    }
);


// ==========================================
// Main fixed-site proxy
// ==========================================

app.use(
    '/:site',
    async (req, res) => {

        const siteName =
            req.params.site;

        const site =
            SITES[siteName];


        if (!site) {

            res.status(404).send(
                `Unknown site: ${siteName}`
            );

            return;
        }


        try {

            const ip =
                await resolveDoH(
                    site.hostname
                );


            console.log(
                `[DNS] ${site.hostname} -> ${ip}`
            );


            const prefix =
                `/${siteName}`;

            let targetPath =
                req.originalUrl;


            if (
                targetPath.startsWith(prefix)
            ) {

                targetPath =
                    targetPath.substring(
                        prefix.length
                    );
            }


            if (!targetPath) {
                targetPath = '/';
            }


            req.url = targetPath;


            console.log(
                `[PROXY] ${req.method} ` +
                `${site.hostname}${targetPath}`
            );


            proxy.web(req, res, {

                target:
                    `${site.protocol}//${ip}`,

                changeOrigin: true,

                selfHandleResponse: true,

                headers: {

                    Host: site.hostname,

                    // Prevent gzip/brotli because
                    // HTML needs to be rewritten.
                    'Accept-Encoding': 'identity'

                },

                agent: new https.Agent({

                    servername:
                        site.hostname

                })

            });

        } catch (error) {

            console.error(
                `[ERROR] ${error.message}`
            );

            if (!res.headersSent) {

                res.status(502).send(
                    `Proxy error: ${error.message}`
                );

            }
        }
    }
);


// ==========================================
// Handle proxy responses
// ==========================================

proxy.on(
    'proxyRes',
    (proxyRes, req, res) => {

        const siteName =
            req.params?.site;

        const site =
            SITES[siteName];


        if (!site) {

            res.writeHead(404);
            res.end();

            return;
        }


        // ----------------------------------
        // Rewrite Location redirects
        // ----------------------------------

        const location =
            proxyRes.headers.location;


        if (location) {

            try {

                const localized =
                    localizeUrl(
                        new URL(
                            location,
                            `${site.protocol}//${site.hostname}`
                        ).href,
                        siteName
                    );


                proxyRes.headers.location =
                    localized;


                console.log(
                    `[REDIRECT] ${location}` +
                    ` -> ${localized}`
                );

            } catch {
                // Leave invalid redirects alone.
            }
        }


        // ----------------------------------
        // HTML
        // ----------------------------------

        const contentType =
            proxyRes.headers['content-type'] || '';


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
                        rewriteHtml(
                            body,
                            siteName,
                            site.hostname
                        );


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


        // ----------------------------------
        // Everything else
        // ----------------------------------

        res.writeHead(
            proxyRes.statusCode || 200,
            proxyRes.headers
        );


        proxyRes.pipe(res);

    }
);


// ==========================================
// Proxy errors
// ==========================================

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


// ==========================================
// Start
// ==========================================

app.listen(
    PORT,
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
            `Listening on http://localhost:${PORT}`
        );

        console.log('');
        console.log('Sites:');


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