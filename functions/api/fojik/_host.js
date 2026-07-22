module.exports = {
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  json: function(data, status, maxAge) {
    status = status || 200;
    maxAge = maxAge || 60;
    return new Response(JSON.stringify(data), {
      status: status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=' + maxAge,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};
