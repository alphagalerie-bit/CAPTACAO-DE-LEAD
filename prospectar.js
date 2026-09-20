/**
 * Conectado — função de prospecção
 * Caminho: netlify/functions/prospectar.js
 *
 * Busca lojas no Google Places (API nova, v1), pega telefone e site de cada uma,
 * varre o site atrás de chat/bot já instalado e devolve tudo pontuado.
 *
 * Variáveis de ambiente (painel do Netlify > Site settings > Environment variables):
 *   GOOGLE_MAPS_KEY   chave com Places API (New) e Geocoding API habilitadas
 *   ORIGEM_PERMITIDA  URL do admin, ex: https://admin.alphagalerie.com
 *
 * NUNCA coloque a chave no HTML. Ele é público assim que você publica.
 */

const CHAT_SIGNATURES = [
  'tawk.to', 'jivochat', 'zendesk', 'zenvia', 'blip.ai', 'take.net',
  'crisp.chat', 'intercom', 'drift.com', 'hubspot', 'rdstation',
  'chatbot', 'manychat', 'botmaker', 'octadesk', 'movidesk',
  'whatsapp-widget', 'wa.me', 'api.whatsapp.com', 'typebot',
  'chatvolt', 'leadster', 'huggy'
];

export async function handler(event) {
  const origem = process.env.ORIGEM_PERMITIDA || '*';
  const cors = {
    'Access-Control-Allow-Origin': origem,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ erro: 'Use POST' }) };
  }

  const KEY = process.env.GOOGLE_MAPS_KEY;
  if (!KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'GOOGLE_MAPS_KEY não configurada no Netlify' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'JSON inválido' }) }; }

  const nicho = String(body.nicho || '').trim();
  const local = String(body.local || '').trim();
  const raioKm = Math.min(50, Math.max(1, Number(body.raioKm) || 5));
  const max = Math.min(60, Math.max(1, Number(body.max) || 20));

  if (!nicho || !local) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'Informe nicho e local' }) };
  }

  try {
    // 1. Transforma o endereço em coordenadas
    const geoUrl = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
      encodeURIComponent(local) + '&region=br&key=' + KEY;
    const geo = await (await fetch(geoUrl)).json();
    if (!geo.results || !geo.results.length) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ erro: 'Endereço não encontrado: ' + local }) };
    }
    const { lat, lng } = geo.results[0].geometry.location;

    // 2. Busca as lojas — Places API (New), Text Search
    const campos = [
      'places.id', 'places.displayName', 'places.formattedAddress',
      'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
      'places.websiteUri', 'places.rating', 'places.userRatingCount',
      'places.primaryTypeDisplayName', 'places.location',
      'places.regularOpeningHours.weekdayDescriptions',
      'places.businessStatus'
    ].join(',');

    const lojas = [];
    let pageToken = null;

    for (let pagina = 0; pagina < 3 && lojas.length < max; pagina++) {
      const payload = {
        textQuery: nicho + ' em ' + local,
        languageCode: 'pt-BR',
        regionCode: 'BR',
        maxResultCount: 20,
        locationBias: {
          circle: { center: { latitude: lat, longitude: lng }, radius: raioKm * 1000 }
        }
      };
      if (pageToken) payload.pageToken = pageToken;

      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': campos + ',nextPageToken'
        },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error.message || 'Erro na Places API');

      (data.places || []).forEach(p => { if (lojas.length < max) lojas.push(p); });
      pageToken = data.nextPageToken;
      if (!pageToken) break;
      await new Promise(res => setTimeout(res, 1200)); // token leva uns segundos pra valer
    }

    // 3. Analisa cada loja
    const resultado = await Promise.all(lojas.map(async p => {
      const site = p.websiteUri || '';
      let semChat = false;

      if (site) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const html = await (await fetch(site, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConectadoBot/1.0)' }
          })).text();
          clearTimeout(timer);
          const baixo = html.toLowerCase();
          semChat = !CHAT_SIGNATURES.some(sig => baixo.includes(sig));
        } catch {
          semChat = true; // site fora do ar ou lento também é sinal ruim
        }
      }

      const horarios = p.regularOpeningHours?.weekdayDescriptions || [];
      const horarioLimitado = horarios.length > 0 &&
        horarios.filter(h => /fechado|closed/i.test(h)).length >= 2;

      return {
        placeId: p.id,
        nome: p.displayName?.text || 'Sem nome',
        categoria: p.primaryTypeDisplayName?.text || nicho,
        endereco: p.formattedAddress || '',
        telefone: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
        site,
        semChat,
        rating: p.rating ?? null,
        reviews: p.userRatingCount ?? null,
        horarioLimitado,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        ativo: p.businessStatus === 'OPERATIONAL'
      };
    }));

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        lojas: resultado.filter(l => l.ativo),
        centro: { lat, lng },
        atribuicao: 'Dados de lugares fornecidos pelo Google'
      })
    };

  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: e.message }) };
  }
}
