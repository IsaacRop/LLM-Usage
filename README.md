# AI Limits

Widget Windows pequeno, local-first, para observar os limites de assinatura do Codex e do Claude Code. Ele não calcula custos, não conta tokens e não estima uso.

## Executar e compilar

Requisitos: Node.js 20+, Rust stable/MSVC, Windows SDK e WebView2.

```powershell
npm install
npm run tauri dev
npm run tauri -- build --no-bundle
```

O executável de release fica em `src-tauri/target/release/llm-usage-monitor.exe`. O projeto usa Tauri 2, React 19, TypeScript e Vite; o bundle de instalador está desativado para manter o build mínimo, mas o executável é standalone.

## Fontes reais dos dados

| Métrica | Fonte | Confiabilidade | Fallback |
| --- | --- | --- | --- |
| Codex current/primary e weekly/secondary: `usedPercent`, duração e `resetsAt` | `codex app-server --stdio`, request first-party `account/rateLimits/read`, disponível no schema gerado pelo Codex CLI instalado | Interface oficial do app-server, marcada experimental pelo CLI; campos são machine-readable | `Unavailable` ou `STALE DATA`; último valor válido continua visível |
| Claude sessão atual e semana: percentual e reset | `claude -p "/usage" --output-format json --no-session-persistence --permission-mode plan`; o app lê apenas as linhas oficiais `Current session` e `Current week (all models)` da resposta | Comando oficial do Claude Code; o formato textual pode mudar entre versões | `Unavailable` ou `STALE DATA`; último valor válido continua visível |

No Codex, a porcentagem exibida vem diretamente de `usedPercent`; `remainingPercent` é somente `100 - usedPercent`. No Claude, o mesmo cálculo é feito sobre o percentual retornado pelo próprio `/usage`. Reset textual do Claude é convertido para timestamp no fuso local apenas para permitir o countdown. Nenhum valor é inferido de tokens, sessões, preço ou custo.

## Autenticação e segurança

Os comandos oficiais reutilizam a sessão local já autenticada pelos próprios clientes. O app não abre navegador, não lê `auth.json`/`.credentials.json`, não copia tokens para a configuração, não grava credenciais, não envia telemetria e não usa backend. Só as preferências do widget são salvas em `settings.json` no diretório de configuração da aplicação. “Launch on Windows” usa a chave `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`.

## Comportamento

- Atualização inicial e aproximadamente a cada 60 segundos, com refresh manual.
- Countdown é local e aciona uma nova coleta quando o reset passa.
- Falha de um provider não derruba o outro; dado válido anterior é mantido como stale.
- Janela frameless, always-on-top, draggable por uma área de arraste nativa, sem taskbar, tray, posição persistida, clamp para a área útil do monitor e modos NORMAL, MINI e COLLAPSED.
- MINI e COLLAPSED alteram o tamanho nativo da janela; NORMAL é redimensionável pelas bordas e oferece presets COMPACT, STANDARD e TALL no painel de controle. O último tamanho NORMAL é preservado.
- O menu do tray permite restaurar, atualizar, trocar modo e sair. `Ctrl+Alt+L` é um atalho global para mostrar/ocultar o widget, mesmo quando ele está atrás de outra janela.

## Limitações conhecidas

O método `account/rateLimits/read` do Codex é experimental no CLI atual; a aplicação detecta falha de protocolo/versão e mostra `Unavailable`. O `/usage` do Claude é uma saída textual machine-readable apenas no envelope JSON, então mudanças nos rótulos ou no idioma podem tornar as janelas indisponíveis até o parser ser atualizado. O app não tenta substituir esses mecanismos por scraping de sites.

Testes principais:

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_collectors_smoke_test
```
