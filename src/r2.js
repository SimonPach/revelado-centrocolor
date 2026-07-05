const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.R2_BUCKET;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// URL pre-firmada para que el navegador SUBA directo a R2 (PUT)
async function urlSubida(key, contentType, expiraSeg = 900) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn: expiraSeg });
}

// URL pre-firmada para DESCARGAR/ver una foto (GET). Temporal.
async function urlDescarga(key, expiraSeg = 3600) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/${key}`;
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiraSeg });
}

// Bajar un objeto de R2 a Buffer (para componer hojas)
async function bajarBuffer(key) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const res = await s3.send(cmd);
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

// Subir un Buffer a R2 (la hoja compuesta)
async function subirBuffer(key, buffer, contentType = 'image/jpeg') {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return key;
}

// Borrar varios objetos de R2 de una vez (hasta 1000 por llamada).
// Ignora keys vacias/nulas. Devuelve la cantidad pedida a borrar.
async function borrarVarios(keys = []) {
  const limpias = [...new Set(keys.filter(Boolean))];
  if (!limpias.length) return 0;
  // DeleteObjects acepta hasta 1000 objetos por request: paginar por las dudas
  for (let i = 0; i < limpias.length; i += 1000) {
    const lote = limpias.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: lote.map((Key) => ({ Key })), Quiet: true },
      })
    );
  }
  return limpias.length;
}

module.exports = { s3, BUCKET, urlSubida, urlDescarga, bajarBuffer, subirBuffer, borrarVarios };
