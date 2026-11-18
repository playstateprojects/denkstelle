# Relation rubric (five labels)

This describes how a person labels a pair and how the code reaches the same five labels from Jev's answers (question set `jev-5`).

- A person picks a label directly, using the table below. Short descriptions are shown by `scripts/label-pairs.ts`.
- Jev never picks a label. It answers one four-way question with a probability per option, and `decide` in `worker/src/jev.ts` turns those into a label. See "How the code decides".
- If you change a rule, change the labelling help, the questions or `decide`, and this file together, and bump `JEV_VERSION`.

You are judging the relation of the **claims** in statements A and B, read as "A relates to B".

- Ignore language (English, German, mixed) and voice ("I find…" vs "the member finds…"). Judge meaning.
- Use the quoted source context only to work out what a statement refers to. The relation is between the statements.
- Judge from the text. Do not guess what the speaker "probably meant".

## The labels

| label | use it when |
| --- | --- |
| `equivalent` | same claim, same polarity and scope. Wording, intensity, language and small number differences do not matter. One could replace the other |
| `agrees` | same side, but a different claim: one is an example of, a reason for, or adds detail to the other |
| `contradicts` | clear, **opposing** positions on the **same** object, aspect and scope, so both cannot be true or both be done |
| `unrelated` | none of the three. Different topics, or the same topic with neither agreement nor opposition |
| `insufficient_context` | you cannot tell what one of the statements refers to |

There is no "same topic" label. A shared topic without agreement or opposition creates no relation between two statements, so it is `unrelated` here. Grouping statements by topic is the theme graph's job. Older labels load as follows: `supports` and `elaborates` count as `agrees`; `related` and `same_topic` count as `unrelated`.

## How the code decides

Jev is asked one question: "How does the claim in A relate to the claim in B?" It must spread a probability of 1 across four options. `insufficient_context` is not one of them.

| option | description given to Jev | label |
| --- | --- | --- |
| `equivalent` | same point, differing only in wording, language, intensity or small details | `equivalent` |
| `agree` | same side of one issue but different points, such as one giving an example or a reason for the other | `agrees` |
| `contradict` | opposing positions on the same thing, or incompatible requests | `contradicts` |
| `unrelated` | neither agrees nor opposes: different things, or the same subject without taking the same or opposite side | `unrelated` |

The code then checks these rules in order and stops at the first that fits. "Agreeing side" means `equivalent` plus `agree`.

| # | condition | label | probability reported |
| --- | --- | --- | --- |
| 1 | agreeing side and `contradict` are both at least 0.25 and within 0.2 of each other | `insufficient_context` | the top option's |
| 2 | the top option is at least 0.5 | that option's label | the top option's |
| 3 | no option reaches 0.5, but the agreeing side does | `agrees` | the agreeing side's |
| 4 | anything else | `insufficient_context` | the top option's |

What follows from this:

- **`insufficient_context` is calculated, never asked.** It means agreement and contradiction are about equally likely (rule 1), or no option is likely enough (rule 4). A person still uses the label for pairs they cannot judge, so the labels show whether the code abstains in the right places.
- **Every decision carries a probability**, so code can apply a stricter threshold for a given use.
- **Rule 3 exists because `equivalent` and `agree` split probability.** A pair at 0.45 and 0.40 is clearly on the agreeing side, so it is `agrees` instead of an abstention.
- **A vague statement can get a confident label.** "It could be better in general" / "the booking is clunky" came out as `agrees` at 0.84.
- **Merging is a separate threshold.** The eval report shows false merges for `equivalent` at 0.5 to 0.9, so the merge threshold can be set higher than the label threshold.

## The rules that were ambiguous before

**Contradicts needs the same thing.**
- Different objects or devices are not a contradiction: "works on the Nexus 4" / "doesn't work on the Nexus 7" is `unrelated`. So is "the laser cutter is always booked" / "the 3D printer is always free".
- Different people disagreeing about the same aspect **is** a contradiction: "booking is clunky" / "booking works fine for me". It is a real divergence the map should surface, even though both experiences can be true.
- Incompatible requests contradict: "add a fixed programme" / "don't over-organise it".
- Compatible wishes do not: "I want more English events" / "I like that things run in English" is `unrelated`.
- If one side is hedged or neutral ("not cheap, not expensive either"), it is `unrelated`, not `contradicts`.
- If scopes might not overlap ("weekends are closed" / "the hours are fine for me"), prefer `unrelated`. Use `contradicts` only when the overlap is clear from the text.

**Equivalent tolerates intensity, not extra claims.**
- "It's loud when a workshop runs" / "unbearably loud when workshops are on" is `equivalent`.
- "Love it, really good" / "A must have, I love this app so much" is `equivalent`.
- Two weeks vs three weeks of waiting is `equivalent` if the claim is "booked out for weeks".
- If one side adds a distinct claim (a cause, a condition, a second complaint), it is `agrees`, not `equivalent`.

**Agrees is for the same side with a different point.**
- "The laser cutter is booked out for weeks" agrees with "Equipment is hard to get".
- "Newcomers get no welcome and nobody shows them where tools are" agrees with "Newcomers get no welcome".
- Direction does not matter.

**Unrelated includes the same topic without a stance.**
- Same problem, different symptom: "instructions are missing" / "instructions are outdated".
- Same problem, different fix: "cheaper plan for occasional users" / "a student discount".
- Same direction, different scope: "open weekends" / "open until 22:00 in the evening".
- One side hedged or neutral.

**Insufficient context is for undecidable pairs.**
- "It could just be better in general" / "the booking is clunky": there is nothing to compare.
- Prefer it over a guess. Do not use it just because the pair is hard.
- This is the labeller's rule. The code has no such question and abstains only as described in "How the code decides".

## Worked examples (invented, not from the candidate sets)

| A                                                         | B                                                | label                |
| --------------------------------------------------------- | ------------------------------------------------ | -------------------- |
| The laser cutter is booked out weeks ahead.               | Den Laserschneider bekommt man erst nach Wochen. | equivalent           |
| The workshops are too loud.                               | It is unbearably loud whenever a workshop runs.  | equivalent           |
| Booking is clunky.                                        | Booking works fine for me.                       | contradicts          |
| Add a fixed workshop programme.                           | Please do not organise it.                       | contradicts          |
| The laser cutter is always booked.                        | The 3D printer is always free.                   | unrelated            |
| I want more events in English.                            | Ich finde gut, dass vieles auf Englisch läuft.   | unrelated            |
| It is too expensive.                                      | It is neither cheap nor expensive.               | unrelated            |
| The laser cutter is booked out for weeks.                 | Equipment is hard to get.                        | agrees               |
| Newcomers get no welcome and nobody shows them the tools. | Newcomers get no welcome.                        | agrees               |
| A cheaper plan for occasional users.                      | A student discount.                              | unrelated            |
| It could be better in general.                            | The booking is clunky.                           | insufficient_context |
| There is no step-free entrance.                           | More visiting artists would help.                | unrelated            |

## Known gray zones (note them, do not agonise)

- Opposing opinions that depend on who is speaking (freelancer vs long-time member on price). The rubric says `contradicts`. If you disagree, put "perspective" in the note field so these can be analysed separately.
- `agrees` vs `equivalent` for a specific instance of a generic claim. If the specific one carries the same point, `equivalent` is fine.
- Anything where you spent more than a minute. Add a note.
