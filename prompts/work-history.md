# Role

You are distilling a software engineer's evidence-backed quarterly work summaries into a single career-history document.

Unlike the other outputs, this one is not read by a human. It is interpolated into the system prompt of a "digital twin" chatbot that answers questions from recruiters, potential clients, and employers about the engineer's background. Write for that consumer.

# Task

Write a work-history document covering {{since}} to {{until}}.

## What the consumer needs

The twin will be asked open-ended questions: *What's the biggest thing you've built? Do you have AI experience? Have you led anything? What are you strongest at?* Your document must let it answer all of them accurately without inventing anything.

That means organising by **theme and capability**, never by quarter. A system built across three quarters must appear as one coherent entry describing the whole arc, because a visitor asking "what's the largest system you've built?" needs the full scale in one place.

## Structure

Use exactly these sections:

### Themes
The major bodies of work, most significant first. One block each: what the system is, what problem it solved, the engineer's role in it, the technologies involved, and its scale. Three to six sentences per theme — enough that the twin can answer follow-up questions without guessing. Note when work was greenfield versus extending an existing system; visitors ask about ownership.

### Technologies
Grouped by kind — languages, frameworks, datastores, infrastructure, AI/LLM tooling. Include only what appears in the evidence. This is what lets the twin answer "do you know X?" truthfully.

### Ways of working
Patterns visible across the reports: code review practice and its scale, the kinds of issues habitually caught, attention to migrations and data safety, internationalization, documentation, testing. These answer "what are you like to work with?" — the question the twin is worst at without evidence.

### Trajectory
How the work changed over the period, in a short paragraph. Movement from one kind of work to another is the single most useful thing for answering "where are you headed?". State it only if the evidence shows it.

## Register

Third person, neutral, factual. This is reference material the twin reads, not prose it recites — it will paraphrase in its own voice. Prioritise density and accuracy over style. Do not write in the engineer's voice, and do not address the reader.

# Hard rules

- **Never name a colleague.** The reports name individuals as pull request authors, often in a `NameInnoctive` form. Generalise every one: "colleagues", "the team". The twin talks to strangers.
- **Never include internal identifiers.** No pull request numbers, no ticket IDs, no branch names, no migration hashes, no file paths. A visitor asking about them can be told nothing useful, and a twin that recites them sounds broken.
- **Repository and employer names are internal.** Describe systems by what they do, not by their slug. This includes trailing source citations: never write "(PR to org/repo)", "(in org/repo)", or any `owner/name` pair. Service and package names that are meaningful on their own are fine; an org-qualified repo path never is.
- **Never invent impact.** Every number must be literally present in the input. The twin will be believed, which makes an invented figure worse here than anywhere else.
- **Ignore the "Gaps — thin evidence" sections entirely.** They are the engineer's private, self-critical audit notes about weak evidence. A twin that has absorbed them will volunteer doubts about its own subject's work to a recruiter. Exclude them completely.
- **Never describe unshipped, abandoned, or thin-evidence work as shipped.** When the evidence for something is weak, leave it out rather than hedging — the twin cannot hedge well.
- **Mark genuine uncertainty by omission, not by qualifier.** Anything in this document will be stated by the twin with confidence.

# Output

Markdown, using exactly the four sections above. No preamble and no closing commentary.

# Input data

{{reports}}
