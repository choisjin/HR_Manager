// HTTPS 인증서: 사내용 인증기관(CA)을 한 번 만들고, 그 CA로 서버 인증서를 발급
// - CA 인증서(ca.crt)를 PC에 한 번 등록하면 브라우저 경고 없이 https 접속
// - 서버 인증서에는 localhost, PC 이름, 이 PC의 내부 IP 들이 들어감 (IP가 바뀌면 자동 재발급)
// data/certs/: ca.key, ca.crt, server.key, server.crt, server.json(발급한 주소 목록)
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const DIR = path.join(process.env.HRM_DATA_DIR || path.join(__dirname, '..', 'data'), 'certs');
const file = (name) => path.join(DIR, name);

// 인증서에 넣을 주소: localhost, PC 이름, 내부 IPv4 전부
function currentNames() {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4')
    .map((n) => n.address);
  const host = os.hostname();
  return {
    dns: [...new Set(['localhost', host, host.toLowerCase()])].sort(),
    ips: [...new Set(['127.0.0.1', ...ips])].sort(),
  };
}

function serial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^[89a-f]/, '1'); // 양수
}

function createCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000); // 10년
  const attrs = [
    { name: 'commonName', value: `HR Manager Internal CA (${os.hostname()})` }, // node-forge 는 이름에 한글 불가
    { name: 'organizationName', value: 'HR Manager' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(file('ca.key'), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(file('ca.crt'), forge.pki.certificateToPem(cert));
}

function createServerCert(names) {
  const caKey = forge.pki.privateKeyFromPem(fs.readFileSync(file('ca.key'), 'utf8'));
  const caCert = forge.pki.certificateFromPem(fs.readFileSync(file('ca.crt'), 'utf8'));
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 825 * 86400000); // 브라우저 허용 최대치 이내
  cert.setSubject([{ name: 'commonName', value: os.hostname() }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...names.dns.map((value) => ({ type: 2, value })), ...names.ips.map((ip) => ({ type: 7, ip }))] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  fs.writeFileSync(file('server.key'), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(file('server.crt'), forge.pki.certificateToPem(cert));
  fs.writeFileSync(file('server.json'), JSON.stringify({ ...names, notAfter: cert.validity.notAfter }, null, 1));
}

// 인증서 준비 (없으면 만들고, 주소가 바뀌었거나 만료 30일 전이면 서버 인증서 재발급)
function ensureCerts() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(file('ca.key')) || !fs.existsSync(file('ca.crt'))) {
    console.log('[https] 사내 인증기관(CA) 인증서를 만듭니다…');
    createCA();
    try {
      fs.unlinkSync(file('server.json')); // 새 CA 로 서버 인증서도 다시 발급
    } catch {}
  }
  const names = currentNames();
  let issued = null;
  try {
    issued = JSON.parse(fs.readFileSync(file('server.json'), 'utf8'));
  } catch {}
  const covers = issued && names.ips.every((ip) => issued.ips.includes(ip)) && names.dns.every((d) => issued.dns.includes(d));
  const fresh = issued && new Date(issued.notAfter) - Date.now() > 30 * 86400000;
  if (!covers || !fresh || !fs.existsSync(file('server.key'))) {
    console.log(`[https] 서버 인증서를 발급합니다 (${[...names.dns, ...names.ips].join(', ')})`);
    createServerCert(names);
  }
  return {
    key: fs.readFileSync(file('server.key')),
    cert: fs.readFileSync(file('server.crt')),
    caPath: file('ca.crt'),
  };
}

// CA 인증서 지문(SHA1) - 실행기가 Windows 인증서 저장소에 등록됐는지 확인할 때 사용
function caThumbprint() {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(fs.readFileSync(file('ca.crt'), 'utf8')))).getBytes();
  return forge.md.sha1.create().update(der).digest().toHex();
}

module.exports = { ensureCerts, caThumbprint, caPath: () => file('ca.crt') };

// 실행기용: node server/tls.js prepare → 인증서 준비 후 CA 지문 출력
if (require.main === module && process.argv[2] === 'prepare') {
  ensureCerts();
  process.stdout.write(caThumbprint());
}
