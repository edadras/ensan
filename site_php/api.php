<?php
// Accumulation of Presence — website API for ordinary PHP hosting (cPanel / DirectAdmin).
// Upload this folder (with the files of /web) to e.g. public_html/presence/
//   GET  api.php/state            current world state
//   GET  api.php/snapshots        which days are archived
//   GET  api.php/snapshot/3       world of day 3  (or /final)
//   GET  api.php/stats            numbers only
//   POST api.php/ingest           the exhibition PC uploads here (header X-Api-Key)

$API_KEY = 'CHANGE-ME-to-a-long-random-secret';   // same as "api_key" in config.json
$DATA = __DIR__ . '/data';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-Api-Key, Authorization');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;
if (!is_dir($DATA)) { mkdir($DATA, 0755, true); file_put_contents("$DATA/.htaccess", "Require all denied\nDeny from all\n"); }

$path = trim($_SERVER['PATH_INFO'] ?? ($_GET['r'] ?? 'state'), '/');
$parts = explode('/', $path);

function out($code, $body) { http_response_code($code); echo is_string($body) ? $body : json_encode($body); exit; }
function save($file, $text) { $tmp = $file . '.tmp' . getmypid(); file_put_contents($tmp, $text, LOCK_EX); rename($tmp, $file); }
$valid = array_merge(array_map('strval', range(1, 30)), ['final']);

switch ($parts[0]) {
  case 'ingest':
    $key = $_SERVER['HTTP_X_API_KEY'] ?? str_replace('Bearer ', '', $_SERVER['HTTP_AUTHORIZATION'] ?? '');
    if (!hash_equals($API_KEY, $key)) out(401, ['error' => 'invalid api key']);
    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) out(400, ['error' => 'bad json']);
    if (isset($data['state'])) {
      save("$DATA/state.json", json_encode($data['state'], JSON_UNESCAPED_UNICODE));
      save("$DATA/version.txt", (string)($data['state']['v'] ?? 0));
    }
    foreach (($data['snapshots'] ?? []) as $k => $s) {
      if (in_array((string)$k, $valid, true)) save("$DATA/snap-$k.json", json_encode($s, JSON_UNESCAPED_UNICODE));
    }
    out(200, ['ok' => true]);

  case 'state':
    if (!file_exists("$DATA/state.json")) out(200, ['v' => 0, 'same' => true]);
    $v = @file_get_contents("$DATA/version.txt");
    if (isset($_GET['since']) && $_GET['since'] === $v) out(200, ['v' => (int)$v, 'same' => true, 'now' => microtime(true)]);
    out(200, file_get_contents("$DATA/state.json"));

  case 'stats':
    $s = json_decode(@file_get_contents("$DATA/state.json") ?: '{}', true);
    out(200, array_merge(['day' => $s['day'] ?? 1, 'phase' => $s['phase'] ?? '', 'evolution' => $s['evolution'] ?? 0], $s['stats'] ?? []));

  case 'snapshots':
    $days = [];
    for ($d = 1; $d <= 30; $d++) if (file_exists("$DATA/snap-$d.json")) $days[] = $d;
    $s = json_decode(@file_get_contents("$DATA/state.json") ?: '{}', true);
    out(200, ['days' => $days, 'final' => file_exists("$DATA/snap-final.json"), 'live_day' => $s['day'] ?? 1, 'total' => $s['days'] ?? 7, 'frozen' => $s['frozen'] ?? false]);

  case 'snapshot':
    $k = $parts[1] ?? '';
    if (!in_array($k, $valid, true) || !file_exists("$DATA/snap-$k.json")) out(404, ['error' => 'no snapshot']);
    header('Cache-Control: public, max-age=60');
    out(200, file_get_contents("$DATA/snap-$k.json"));
}
out(404, ['error' => 'unknown endpoint']);
