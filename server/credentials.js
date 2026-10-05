// 로그인 정보 저장 (브라우저별) - 비밀번호는 Windows DPAPI 로 암호화 (서버 PC의 같은 Windows 계정에서만 복호화 가능)
// 브라우저 쿠키의 무작위 토큰으로 구분, 서버에는 토큰의 해시만 저장
// data/login.json: { browsers: { <sha256(토큰)>: { id, password: <DPAPI 암호문>, auto, updatedAt } } }
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const FILE = path.join(process.env.HRM_DATA_DIR || path.join(__dirname, '..', 'data'), 'login.json');

// 비밀번호는 명령줄 인자가 아니라 stdin 으로 전달 (프로세스 목록에 노출되지 않게)
function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()))
    );
    child.stdin.end(input);
  });
}

// .NET ProtectedData(DPAPI, CurrentUser) 직접 사용. 입출력은 base64 (한글 등 인코딩 문제 방지)
const DPAPI = 'Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser;';
const ENCRYPT = `${DPAPI} [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in), $null, $scope)))`;
const DECRYPT = `${DPAPI} [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, $scope)))`;

const encrypt = async (plain) => powershell(ENCRYPT, Buffer.from(plain, 'utf8').toString('base64'));
const decrypt = async (blob) => Buffer.from(await powershell(DECRYPT, blob), 'base64').toString('utf8');

function readAll() {
  try {
    const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return all && all.browsers ? all : { browsers: {} }; // 예전(서버 하나에 한 명) 형식은 버림
  } catch {
    return { browsers: {} };
  }
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 1));
}

const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function entry(token) {
  return token ? readAll().browsers[tokenKey(token)] || null : null;
}

// 화면에 줄 정보 (비밀번호는 절대 포함하지 않음)
function info(token) {
  const e = entry(token);
  return e ? { id: e.id || '', hasPassword: !!e.password, remember: true, auto: !!e.auto } : { id: '', hasPassword: false, remember: false, auto: false };
}

// 저장 후 이 브라우저의 토큰 반환 (없으면 새로 발급)
async function save(token, id, password, { auto }) {
  const t = token && entry(token) ? token : newToken();
  const blob = await encrypt(password);
  const all = readAll();
  all.browsers[tokenKey(t)] = { id, password: blob, auto: !!auto, updatedAt: new Date().toISOString() };
  writeAll(all);
  return t;
}

function clear(token) {
  if (!token) return;
  const all = readAll();
  delete all.browsers[tokenKey(token)];
  writeAll(all);
}

// 이 브라우저에 저장된 비밀번호 (id 가 다르면 null)
async function savedPassword(token, id) {
  const e = entry(token);
  if (!e || !e.password || (id && e.id !== id)) return null;
  return decrypt(e.password);
}

module.exports = { info, save, clear, savedPassword, encrypt, decrypt };
