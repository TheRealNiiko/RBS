import express from 'express';
import httpProxy from 'http-proxy';
import https from 'https';

const app = express();
const proxy = httpProxy.createProxyServer({});

const PORT = 8080;

const DOH_SERVER =
    'https://cloudflare-dns.com/dns-query';


// ==========================================
// Fixed sites
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
// Rewrite HTML URLs
// ==========================================

function rewriteHtml(
    html,
    siteName,
    hostname
) {

    const escapedHostname =
        hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // https://github.com/foo
    html = html.replace(
        new RegExp(
            `https?:\\/\\/${escapedHostname}`,
            'gi'
        ),
        `/${siteName}`
    );

    // //github.com/foo
    html = html.replace(
        new RegExp(
            `\\/\\/${escapedHostname}`,
            'gi'
        ),
        `/${siteName}`
    );

    return html;
}


// ==========================================
// Handle proxy request
// ==========================================

app.use('/:site', async (req, res) => {

    const siteName = req.params.site;
    const site = SITES[siteName];

    if (!site) {
        res.status(404).send(
            `Unknown site: ${siteName}`
        );
        return;
    }

    try {

        // ----------------------------------
        // Resolve hostname using DoH
        // ----------------------------------

        const ip = await resolveDoH(
            site.hostname
        );

        console.log(
            `[DNS] ${site.hostname} -> ${ip}`
        );


        // ----------------------------------
        // Remove /github from the URL
        // ----------------------------------

        let targetPath = req.originalUrl;

        const prefix = `/${siteName}`;

        if (targetPath.startsWith(prefix)) {
            targetPath =
                targetPath.substring(prefix.length);
        }

        if (!targetPath) {
            targetPath = '/';
        }

        req.url = targetPath;


        console.log(
            `[PROXY] ${req.method} ${site.hostname}${targetPath}`
        );


        // ----------------------------------
        // Proxy
        // ----------------------------------

        proxy.web(req, res, {

            target:
                `${site.protocol}//${ip}`,

            changeOrigin: true,

            selfHandleResponse: true,

            headers: {

                // Tell GitHub which hostname
                // we're actually requesting.
                Host: site.hostname,

                // VERY IMPORTANT:
                // Don't let GitHub gzip/brotli
                // the response because we need
                // to modify the HTML.
                'Accept-Encoding': 'identity'

            },

            agent: new https.Agent({

                // TLS certificate/SNI should
                // still use github.com rather
                // than the IP address.
                servername: site.hostname

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

});


// ==========================================
// Handle responses
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
        // Rewrite redirects
        // ----------------------------------

        const location =
            proxyRes.headers.location;

        if (location) {

            try {

                const target =
                    new URL(
                        location,
                        `${site.protocol}//${site.hostname}`
                    );

                if (
                    target.hostname ===
                    site.hostname
                ) {

                    proxyRes.headers.location =
                        `/${siteName}` +
                        `${target.pathname}` +
                        `${target.search}` +
                        `${target.hash}`;

                    console.log(
                        `[REDIRECT] ${location} -> ` +
                        `${proxyRes.headers.location}`
                    );
                }

            } catch {
                // Leave malformed Location headers alone.
            }
        }


        // ----------------------------------
        // Content type
        // ----------------------------------

        const contentType =
            proxyRes.headers['content-type'] || '';


        // ----------------------------------
        // Rewrite HTML
        // ----------------------------------

        if (
            contentType.includes('text/html')
        ) {

            const chunks = [];

            proxyRes.on(
                'data',
                chunk => chunks.push(chunk)
            );

            proxyRes.on(
                'end',
                () => {

                    let body =
                        Buffer
                            .concat(chunks)
                            .toString('utf8');


                    body = rewriteHtml(
                        body,
                        siteName,
                        site.hostname
                    );


                    // The body changed size.
                    // Remove the old length.
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
        // Non-HTML responses
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
            res.writeHead(502, {
                'Content-Type':
                    'text/plain'
            });
        }

        res.end(
            `Proxy connection failed: ${error.message}`
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