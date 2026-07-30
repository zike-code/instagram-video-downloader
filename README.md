# IG Profile Video Downloader

Extensão Chrome/Edge (Manifest V3) para coletar e baixar os vídeos (posts + Reels)
de um perfil do Instagram, usando a sua própria sessão logada no navegador.

## Como funciona

Em vez de recriar a API privada do Instagram (que exige headers específicos e muda
com frequência), a extensão **intercepta as respostas de rede que o próprio
Instagram já busca** enquanto você rola o perfil. Um script injetado no contexto
da página (`content_main.js`) faz hook em `fetch`/`XMLHttpRequest`, procura por
vídeos nas respostas JSON e repassa para a extensão.

Um segundo script (`content_isolated.js`) rola a página automaticamente (feed e,
se existir, a aba Reels) para forçar o carregamento de mais posts, e abre os
posts que ainda não têm vídeo capturado (o HTML inicial só traz os primeiros
~12 completos; o resto exige abrir o post individualmente).

A interface roda num **painel lateral** (Side Panel do Chrome, o mesmo padrão
usado por extensões como a MetaMask) em vez de um popup tradicional — assim
ela fica fixa na tela e não fecha sozinha ao perder o foco.

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions`.
2. Ative o "Modo do desenvolvedor" (canto superior direito).
3. Clique em "Carregar sem compactação" e selecione a pasta `instagram-video-downloader`.

## Uso

1. Faça login no Instagram normalmente pelo navegador.
2. Abra o perfil desejado (`instagram.com/usuario`).
3. Clique no ícone da extensão — isso abre o painel lateral (fica fixo até você fechar).
4. Clique em **"Escanear perfil"** e aguarde. O contador de vídeos encontrados
   atualiza em tempo real.
5. Para baixar, duas opções:
   - **"Baixar todos (pasta Downloads)"** — salva em
     `Downloads/instagram/<usuario>/<data>_<código>.mp4`.
   - **"Escolher pasta..." + "Baixar todos nessa pasta"** — deixa você escolher
     qualquer pasta do computador (via File System Access API) e salva os
     arquivos direto ali.
   - Cada vídeo na lista também tem botões individuais: ↓ (verde) baixa só
     aquele vídeo, × (vermelho) remove da lista.

## Limitações e avisos importantes

- **Fragilidade**: o Instagram muda o formato das respostas com frequência.
  Se parar de encontrar vídeos, é provável que o formato tenha mudado e o
  scanner (`extractVideos` em `content_main.js`) precise de ajuste.
- **Stories** não estão implementados (expiram rápido e têm um fluxo de rede
  diferente); só posts do feed e Reels.
- **Carrosséis** (posts com vários vídeos/fotos) são capturados desde que o
  Instagram carregue os dados do vídeo na resposta.
- **Rate limiting**: rolar muito rápido ou baixar centenas de vídeos de uma vez
  pode fazer o Instagram limitar ou sinalizar a conta. Os scripts já colocam
  pequenos delays; evite rodar isso o tempo todo ou em várias contas seguidas.
- **Uso responsável**: use apenas para conteúdo seu ou de perfis para os quais
  você tem permissão de baixar/reaproveitar. Baixar e redistribuir vídeos de
  terceiros sem autorização pode violar direitos autorais e os Termos de Uso
  do Instagram.

## Estrutura

```
instagram-video-downloader/
├── manifest.json               # config da extensão (MV3)
├── content_main.js              # hook de fetch/XHR (MAIN world)
├── content_isolated.js           # auto-scroll + abre posts + relay de mensagens
├── background.js                # estado por aba + downloads + side panel
├── sidepanel.html / sidepanel.js # UI da extensão (painel lateral)
```
