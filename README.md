# DENKSTELLE

**Setz dich. Denk laut.**  
*Can AI reveal what makes our perspectives different, instead of summarizing them into sameness?*

> **Work in progress · November 2026.** A working-code prototype and an experiment in collective intelligence, model diversity, and evidence-linked qualitative analysis. Not a production-ready public recording service.

## The idea

Five people answer the same question. A conventional survey counts their positions; a conventional AI summary tells us what they broadly agree on.

But what did **one person notice that everyone else missed**? Where do apparently opposed views share an assumption? Which small detail changes how we understand the whole conversation?

Denkstelle explores whether AI can help surface those distinctions without smoothing them away.

People record short interviews around a shared question. The system transcribes the recordings, extracts evidence-linked statements, discovers recurring themes, and makes them explorable as a graph. It can also propose short, reviewable video highlights assembled from participants' **actual words**.

The aim is not to replace interpretation with an authoritative machine verdict. It's to give people a better way to listen, compare, question, and return to the source.

## The experiment: models aren't interchangeable

A second question drives the technical work:

**If two LLMs read the same human conversation, do they notice different things?**

The prototype currently supports **Mistral** and **DeepSeek** for analysis, with separate, versioned prompt configurations. The admin interface can run both models against the same sample transcript and display their interpretations side by side.

This isn't intended as another leaderboard. I want to explore:

- **Model literacy:** what changes when we adapt an instruction to a model's particular strengths and interpretive tendencies?
- **Preserving nuance:** what gets lost between an original recording, a transcript, a structured claim, and a theme?
- **Grounded surprise:** can a model identify an overlooked detail without inventing significance?
- **Useful diversity:** could contrasting models help reveal blind spots in one another, rather than forcing every model into the same output style?

The code holds the *output contract* steady where useful, while allowing the prompts to differ by model. Both models must provide structured statements linked to numbered transcript segments. The original media and transcript remain available for human scrutiny.

**Current limitation:** the comparison interface works at the per-interview extraction level in code. Durable experiment runs, systematic human evaluation, and tested cross-model insight synthesis are next steps. The graph currently shows thematic co-occurrence and embedding similarity, **not verified agreement or disagreement**.

## What's in the repository

These are implemented code paths, **not claims of a fully tested deployment**:

| Area | Current implementation |
| --- | --- |
| Interview capture | Mobile/iPad-oriented camera and microphone recording, replay, consent and anonymous receipt codes |
| Processing | FFmpeg audio extraction, Cloudflare Whisper transcription, model-based statement extraction, embeddings and PostgreSQL ingestion |
| Evidence | Source segments with timestamps, statements linked to transcript evidence, source-aware storage |
| Graph | Cross-interview theme synthesis and interactive 3D visualization; co-occurrence and semantic proximity |
| Model experiments | Mistral / DeepSeek adapters, per-model versioned prompts, sample transcript comparison |
| Editorial output | Suggested excerpts and reviewable multi-speaker highlight reels rendered from original video |
| Operations | Cloudflare Workers, Queues, Container processor, R2 media, retryable PostgreSQL job queue |
| Source extensibility | Schema supports video, audio, text and documents; importers beyond recorded interviews are future work |

### Architecture at a glance

```text
Participant -> SvelteKit capture + consent -> private R2 video
                                            |
                                            v
                               Postgres job + Cloudflare Queue
                                            |
                                            v
                                Cloudflare Container (FFmpeg)
                                            |
                                            v
                               Whisper transcript + timestamps
                                            |
                      +---------------------+-------------------+
                      |                                         |
                 Mistral / DeepSeek                        Embeddings
                 model-specific prompts                        |
                      |                                         |
                      +---------------------+-------------------+
                                            |
                                            v
                          Statements + source evidence + themes
                                            |
                               +------------+------------+
                               |                         |
                          3D topic graph          Reviewable video reels
```

The app is built with **SvelteKit 5, TypeScript, Tailwind CSS, Cloudflare Workers/Containers/R2/Queues, PostgreSQL with pgvector, FFmpeg**, and external model APIs. The container handles workloads that aren't appropriate for a request-bound Worker.

A design priority is **reversibility**: retain the original evidence, version prompts, identify the model behind interpretations, and avoid baking a provider's output format into the core data model. That doesn't mean provider migration is effortless: differences in tool behavior, structured output, latency, embeddings, and cost are part of the experiment.

## What I want to demonstrate at AI Tinkerers Berlin

A small, inspectable experiment:

1. Start with a few real interviews answering the same question, such as *“When should an AI agent be allowed to act without human approval?”*
2. Show the evidence-linked themes and recorded excerpts.
3. Run the **same transcript through Mistral and DeepSeek**, first with comparable prompts, then with model-specific prompt variations.
4. Look at what each interpretation includes, omits, or overstates. Return to the original recording when a supposed insight needs checking.
5. Open the code and talk about the practical trade-offs: prompt management, data provenance, lightweight deployment, and avoiding unnecessary model lock-in.

**This is a planned demonstration, not yet a validated result.** I don't know whether the models will produce meaningfully different interpretations. Finding that out is the interesting part.

## Why this matters

A lot of AI software is designed to compress complexity: summarize the meeting, find the consensus, produce the answer.

There are good reasons to do that. But compression can also erase minority perspectives, ambiguous observations, and the details that make an idea new.

Denkstelle is one practical attempt at a different goal: **use AI to direct human attention towards what deserves a closer look**.

The longer-term possibilities include facilitated workshops, conferences, qualitative research, civic participation, and organizational learning. A portable interview booth is one interface, not the entire product.

## Status and limitations

**Early prototype.** The repository contains capture, analysis, graph, prompt management, and media-production implementations. End-to-end behavior on real iPads, cloud credentials, deployed queues/containers, and reliability still need to be validated.

- Theme co-occurrence **does not prove** agreement, consensus, or representativeness.
- Model-generated statements and highlights require review against their source.
- Recording, storage, and processing currently depend on cloud services; **this is not an offline system**.
- The current prototype is **not ready for unsupervised public recording**. A real pilot needs project-specific privacy information, lawful-basis and processor review, retention policies, security controls, upload limits, and abuse protection.
- The Mistral / DeepSeek comparison needs reproducible saved runs and evaluations before any claims about model-specific behavior can be made.

For setup, migrations, worker deployment, operational details, and privacy caveats, see **[Development and operations](docs/DEVELOPMENT.md)**.

## About / collaboration

Denkstelle is an independent experiment by **Tom Cox**, a Berlin-based creative technologist working across software, art, and systems for collective understanding.

I'm interested in the point where engineering meets interpretation: how we make AI applications technically useful **without letting their categories flatten the people and experiences they represent**.

I'd welcome conversations with people working on model evaluation, language, human-computer interaction, qualitative research, or potential pilot applications. The project is open to technical collaborators and exploratory paid pilots.

[GitHub repository](https://github.com/playstateprojects/denkstelle)
