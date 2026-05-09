# Why is there no LLM for Guandan? I spent two months trying to find out. Then I discovered someone already did it, better.

This is a launch post and a postmortem at the same time. I'd rather write it honestly than pretend the second half didn't happen.

## The original question

Guandan (掼蛋) is the four-player trick-taking card game that has quietly become the dominant social card game across eastern China. Hundreds of millions of people play it. There are corporate tournaments. There is a national association. And yet, a few months ago, when I went looking for an AI you could actually play against in a browser, the answer was effectively "no."

The two well-known research efforts — [OpenGuanDan](https://github.com/GameAI-NJUPT/OpenGuanDan) and [DanZero](https://arxiv.org/abs/2210.17087) — are real, serious work. Neither shipped a usable GUI. Neither released open weights you could actually run. If you wanted to play against an AI in your browser, you couldn't.

So I decided to fix that.

## What I built

Over the last couple of months I built [Guandan Arena](https://guandan-arena-sigma.vercel.app/):

- A TypeScript + React + Vite Guandan engine and browser UI, deployable to Vercel with one click.
- A practice mode where you sit at one seat and three AIs fill the other three.
- An arena spectator mode where you can watch four AI agents play each other — mixing rule-based bots, reinforcement-learning bots, and chat-LLMs (DeepSeek, Kimi, Gemma) at the same table.
- A small ScoreNet policy trained with imitation warm-start plus PPO, on a Mac mini.

The training story is the one I was excited to tell. An Apple M4 Mac mini, 32 GB of RAM, MPS backend, eight parallel self-play workers, 300 matches per outer iteration, around 90 PPO outer iterations per multi-day run. Total calendar time across iterations was roughly two and a half weeks of mostly-on training. The model is small enough to ship, fast enough to feel instant in the browser, and — vibe-tested — strong enough that I genuinely enjoy playing against it.

I was about a week from posting a launch when I made a search I should have made on day one.

## Then I found DanLM

[DanLM](https://github.com/dashidhy/DanLM), released March 26, 2026, is essentially the project I set out to build. Open weights checked into the repo. A web UI you can play against. Three trained agents bundled (their reproduction of DanZero, their improved DanZero, and their own new architecture). Trained on Apple Silicon. Vibe-coded with Claude Opus 4.6, which they openly disclose in their README.

It is also better than mine on every metric that matters for a "Guandan AI."

DanLM hit #1 on the Botzone GuanDan leaderboard in April, beating all 30 other bots. It is currently #2. Their published evaluation against the strongest competition baselines from the National Guandan AI Algorithm Competition shows win rates in the 80s. My strongest checkpoint, evaluated against my own strongest heuristic, sits at 42%. My heuristic is itself weaker than Botzone's baselines. So the honest gap is significantly larger than it looks.

This is not a near miss. This is somebody who started a few weeks before me, made better methodological choices, ran more rigorous evaluation, and shipped six weeks earlier.

I sat with that for a day.

## What I actually learned

The post I was going to write had three lessons. They all still stand. Two of them, getting scooped sharpened rather than weakened.

### Lesson 1: Stop asking "why isn't this built yet"

The old instinct, when you saw a gap, was to assume you must be missing something — *if this were a good idea, surely someone would have done it already*. That instinct made sense in a world where building anything took a team and a year.

It does not make sense now. The amount of stuff worth building is unbounded, and there is no asymptote where "all the useful things are done." When you see something that should exist and doesn't, the most likely explanation is just that nobody has gotten around to it yet.

The kicker is that this lesson is most strongly proven by getting scooped. DanLM and I independently arrived at the same project, with the same vibe-coded methodology, on the same hardware family, within the same calendar quarter. The reason to build the thing is *not* that you'll be the only one. The reason to build it is that the field is wide enough that two people building the same thing in parallel is now the normal case.

The right response to discovering parallel work is not to abandon yours. It is to figure out what is actually distinct about yours, and double down on that.

### Lesson 2: LLMs are not the answer to everything

My first instinct was, of course, to throw an LLM at it. Around 2,000 tokens of input per hand to describe state, hand, history, and legal moves. With reasoning enabled, well over a dollar per full game. Multi-second moves. And it still played mediocre Guandan.

So I gave up on that path and trained a small specialized model instead. So did DanLM, on a different stack, with a different architecture, arriving at essentially the same conclusion: a small purpose-built Transformer trained on a hobby budget will dominate a general-purpose chat model on cost, latency, and skill — all three.

Two independent projects converging on this from different directions is, if anything, stronger evidence than either one alone.

### Lesson 3: You never know until you try

I started this assuming an LLM would just work. It didn't. I then assumed I should go full AlphaGo — MCTS plus a deep value network, the way DanZero did it. The DanZero paper itself notes the compute is enormous; that is not a single-Mac-mini project.

What ended up working was something I stumbled into. Before training the neural net, I used Claude Opus to crank out a sequence of hand-written agents — a clean rule-based player, then several rounds of rule-based plus scored rollouts, then a top-K plus multi-policy Monte Carlo rollout agent. I built them as opponents for evaluation. They turned out to make an excellent training curriculum. Instead of pure self-play from scratch, I used them as progressively harder teachers — easy ones first, harder ones once the model improved.

This converged dramatically faster than pure self-play in my (vibe-checked, not rigorously tested) experience. DanLM took the opposite bet — pure self-play DMC with no domain knowledge, "tokenization is all you need." Their results suggest their bet paid off. Mine paid off less, against a less rigorous benchmark. The methodological difference is real and worth understanding properly. I plan to.

## What's next, and what's actually mine

Being second on the model is fine if I'm honest about it and find a different niche. There is one piece of this project that is genuinely novel and that nobody else, including DanLM, is doing.

I want to build a public arena where chat-LLMs play Guandan against each other. DeepSeek vs Qwen vs Kimi vs GPT vs Claude vs Gemma, all at the same table, with leaderboards, win-rate matrices, cost-per-game, and latency. The infrastructure is already mostly built — my arena spectator already runs four agents at one table. The missing pieces are the leaderboard, the cost accounting, and a way to fund the inference.

The question I actually want to answer is: do Chinese-trained LLMs play this Chinese cultural game better than Western ones? I don't know the answer. Nobody has measured it. That seems worth measuring.

I'm also going to keep training the small PPO model and see if the curriculum approach can close the gap with DanLM. Probably it can't all the way. But I'd like to know how far it can go.

## If you have suggestions, please reach out

If you want to play a few hands against the bot: [guandan-arena-sigma.vercel.app](https://guandan-arena-sigma.vercel.app/).

If you have ideas on how to fund inference for the LLM arena, or want to sponsor specific models in the leaderboard: please reach out.

If you have suggestions on the methodology: also please reach out.

The project exists because I stopped asking why nobody had built it. It survived getting scooped because the part that's actually mine turned out to be the part nobody else was doing. That is, in retrospect, the lesson under the lesson.