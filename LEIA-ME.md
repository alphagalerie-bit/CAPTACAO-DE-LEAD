# Conectado — Admin + Gateway

Sistema completo pra prospectar, atender com IA e cobrar. Quatro peças que conversam entre si.

| Peça | O que faz | Onde roda |
|---|---|---|
| `public/index.html` | Painel, prospecção, CRM, disparo, treino do agente, preços, contratos e MRR | Netlify (com senha) |
| `gateway/server.js` | Segura a sessão do WhatsApp, roda a IA nas mensagens recebidas, cria cobrança no Mercado Pago | Railway ou Render |
| `netlify/functions/prospectar.js` | Busca lojas reais no Google Places | Netlify Functions |
| `db/schema.sql` | Banco do CRM, pra usar em vários aparelhos | Supabase |

---

## Faça isto antes de qualquer coisa

**Renove o Access Token do Mercado Pago.** O que você colou no chat e apareceu na captura de tela está comprometido. Esse token cria cobrança, estorna e lê o extrato da sua conta.

1. Mercado Pago → *Suas integrações* → sua aplicação → *Credenciais de produção*
2. Clique em **Renovar Access Token**
3. O novo vai direto na variável `MP_ACCESS_TOKEN` do gateway, e em nenhum outro lugar

A **Public Key** (`APP_USR-4fceeb1b-...`) pode ficar no HTML — ela é pública por natureza e já está no `CONFIG`.

---

## 1. Colocar o painel no ar (Netlify)

O projeto **captacao-alpha** já existe na sua conta Netlify:
<https://app.netlify.com/projects/captacao-alpha>

Falta ligar ele neste repositório. São três cliques, e depois todo push publica sozinho:

1. Abra o projeto → **Project configuration › Build & deploy › Link repository**
2. Escolha o GitHub e o repositório `alphagalerie-bit/captacao-de-lead`
3. Branch de produção: `main`. As configurações de build já vêm do `netlify.toml`
   (publica a pasta `public`, funções em `netlify/functions`, sem comando de build).

Clique em **Deploy** e o painel sobe em <https://captacao-alpha.netlify.app>.

**Ponha senha antes de usar com lead de verdade.** O painel guarda nome, telefone e
contrato de cliente. Em *Project configuration › Access & security › Visitor access*,
ligue **Password protection**. O `robots.txt` e o `X-Robots-Tag` já bloqueiam buscador,
mas isso não é senha.

**Chave do Google.** Enquanto `GOOGLE_MAPS_KEY` não estiver em *Environment variables*,
a busca cai sozinha em modo demonstração, com aviso na tela — o resto do painel (CRM,
preços, contratos, MRR) funciona normal. Quando quiser buscar loja de verdade:
*Site configuration › Environment variables › Add* → `GOOGLE_MAPS_KEY` com uma chave que
tenha **Places API (New)** e **Geocoding API** habilitadas.

### Rodar na sua máquina, sem publicar

Abra o `public/index.html` direto no navegador. Funciona sozinho, em modo demonstração:
prospecção com lojas fictícias, CRM completo, tabela de preços editável, contratos e MRR.
O teste do agente roda em modo roteiro, seguindo a sequência de qualificação sem consumir
token. Serve pra você validar preço, funil e roteiro antes de gastar com API.

---

## 2. Subir o gateway e conectar o WhatsApp

O QR Code precisa de um processo Node vivo, com socket aberto. Função serverless não serve — ela morre a cada requisição e a sessão cai junto.

**Railway** (mais simples):

1. Aponte o Railway pra este repositório, com *Root Directory* = `gateway`
2. railway.app → *New Project* → *Deploy from GitHub*
3. Em *Variables*, cole o `gateway/.env.example` preenchido:
   - `CONECTADO_TOKEN` — invente uma senha longa e aleatória
   - `ANTHROPIC_API_KEY` — pegue em console.anthropic.com
   - `MP_ACCESS_TOKEN` — o **novo** que você acabou de renovar
   - `ORIGEM_PERMITIDA` — a URL do admin (ex: `https://captacao-alpha.netlify.app`)
4. Em *Settings > Volumes*, monte um volume em `/app/sessao`. Sem isso a sessão se perde a cada deploy e você reescaneia o QR toda vez.
5. Copie a URL pública que o Railway gerou

No `CONFIG` do admin:

```js
gateway: "https://seu-app.up.railway.app",
gatewayToken: "a-mesma-senha-do-CONECTADO_TOKEN",
```

**Conectar o número 11 97212-8715:**

Admin → *Ajustes* → **Gerar QR Code** → no celular: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho → aponte a câmera.

O QR expira em uns 40 segundos. Se sumir, gere de novo. Assim que conectar, o rodapé da barra lateral fica verde e a IA já responde quem te mandar mensagem.

---

## 3. Como a IA se comporta

**Ela responde** quem manda mensagem pra você, usando o treino da aba *Agente IA* mais a tabela de preços — sempre com os valores exatos que você cadastrou.

**Ela cala a boca** nestas situações:

- Você responde manualmente pelo celular → ela some por 30 minutos daquela conversa (ajustável em `PAUSA_HUMANA_MIN`)
- A pessoa usa alguma palavra da lista de escalonamento → avisa que vai te chamar e para
- A pessoa pede pra não ser mais contatada → entra no opt-out e nunca mais recebe nada

**Ela nunca:**

- Inventa preço ou prazo — só fala o que está na tabela
- Dá desconto acima do limite definido em *Preços > Regras*
- Inicia conversa nova sozinha

**Ela não dispara frio.** Isso continua clique-a-clique no admin, de propósito. Conectar por QR já contraria os Termos do WhatsApp; blastar conversa nova por ali derruba o número em dias — e é o mesmo número dos seus clientes pagantes.

---

## 4. A tabela de preços

Editável na aba *Preços*. Cada serviço tem instalação, mensalidade e **seu custo** — o sistema mostra a margem na hora. O que vem por padrão:

| Serviço | Instalação | Mensal | Seu custo | Margem |
|---|---|---|---|---|
| Atendimento IA no WhatsApp | R$ 297 | R$ 59,90 | R$ 12 | R$ 47,90 |
| Site institucional | R$ 697 | R$ 19,90 | R$ 3 | R$ 16,90 |
| Catálogo / loja virtual | R$ 1.197 | R$ 29,90 | R$ 5 | R$ 24,90 |
| Google Meu Negócio (GEO) | R$ 197 | R$ 14,90 | R$ 2 | R$ 12,90 |
| Landing page de campanha | R$ 397 | R$ 9,90 | R$ 2 | R$ 7,90 |
| Integração de pagamento | R$ 297 | R$ 9,90 | R$ 1,50 | R$ 8,40 |
| Gestão de tráfego | — | R$ 397 | R$ 60 | R$ 337 |

Pacotes com desconto, calculado sozinho quando o cliente marca os serviços:

| Pacote | Inclui | Desconto | Entrada | Mensal |
|---|---|---|---|---|
| Essencial | IA + GEO | 10% | R$ 444,60 | R$ 67,32 |
| Presença | IA + Site + GEO | 12% | R$ 1.048,08 | R$ 83,34 |
| Completo | IA + Site + GEO + Pagamento | 15% | R$ 1.264,80 | R$ 88,91 |
| Máximo | IA + Loja + GEO + Pagamento + LP | 18% | R$ 1.955,70 | R$ 102,09 |

Desconto contido, como você pediu — 10% a 18%. A margem fica em torno de 79% em todos os pacotes, então nenhum combo te deixa trabalhando de graça.

### Sobre a mensalidade baixa

Você pediu faixas de R$9,90 a R$19,90. Elas estão lá, mas nos serviços **passivos**: hospedagem de site, ficha do Google, link de pagamento. Depois de prontos quase não custam nada, então a recorrência é lucro limpo e o dinheiro cai todo dia — que era o objetivo.

O atendimento de IA é diferente: queima token a cada conversa. Uma loja movimentada gasta entre R$8 e R$15 por mês só de API. Cobrar R$9,90 nesse serviço te coloca no prejuízo justamente com o cliente que mais usa — e cliente que usa muito é o que menos cancela. Por isso a IA está em R$59,90, e o recorrente barato vem dos passivos ao lado.

Na prática: um cliente do Essencial paga R$444,60 de entrada e R$67,32 por mês. Trinta clientes desses são **R$ 2.019,60 de MRR**, com uns R$420 de custo total.

Tudo isso é editável. Se quiser testar o cenário de R$19,90 na IA, mude o valor e a coluna de margem te mostra na hora o que acontece.

---

## 5. Cobrança

Na ficha do lead, aba *Contrato*: marque os serviços, o sistema identifica o melhor pacote e calcula entrada, mensalidade e margem. Defina o dia do vencimento e clique em **Gerar link de pagamento** — o gateway cria a preferência no Mercado Pago com instalação e primeiro mês, já parcelável.

O botão seguinte manda o link pro WhatsApp do cliente com a mensagem pronta.

Quando o pagamento cai, o Mercado Pago avisa o gateway em `/pagamento/webhook`. Pra isso funcionar, preencha `URL_GATEWAY` nas variáveis e cadastre a mesma URL em *Suas integrações > Webhooks*.

O painel mostra MRR, setup faturado no mês, assinaturas ativas e quem está atrasado.

---

## 6. O que a LGPD exige

Prospecção B2B é permitida por legítimo interesse (art. 7º, IX), com condições:

- Se identificar na primeira frase — os templates já fazem isso
- Dizer de onde veio o contato, se perguntarem
- Oferecer saída fácil e respeitar na hora. O gateway detecta pedidos de descadastro e bloqueia o número permanentemente
- Não comprar lista de terceiros

---

## 7. Rotina sugerida

**Segunda:** busca um nicho novo, 40 lojas, adiciona as de score acima de 60.
**Todo dia de manhã:** fila de 20 a 30 abordagens (10 a 15 na primeira semana do número).
**Todo dia à tarde:** o painel mostra quem foi abordado há 2+ dias sem resposta — roda o follow-up.
**Sexta:** exporta o CSV, confere MRR e olha quais templates respondem melhor.

A IA cuida de tudo que chega. Você cuida do que sai.
