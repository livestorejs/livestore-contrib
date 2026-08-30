# Discord Documentation Assistant — Ontology

## Language

- **Docs Request:** One explicit `/docs` invocation plus the minimum Discord
  routing information needed to respond. It contains a Query and may contain
  Query Context selected under the Context Policy.
- **Query:** The user's question about LiveStore documentation. It is content,
  not identity or Discord routing metadata.
- **Query Context:** Additional Discord message content deliberately selected to
  disambiguate a Query. It is optional, bounded, and subject to the Context
  Policy. _Avoid:_ ambient history, conversation scrape.
- **Context Policy:** The contract deciding whether Query Context is allowed and,
  if so, how it is selected, bounded, disclosed, and retained.
- **Audience Policy:** The contract deciding which Discord members may invoke
  the documentation assistant. It is configuration or Discord-native policy,
  not an identity hard-coded into command logic.
- **Audience Route:** One named Audience Policy path combining a configured
  channel class, native command permission, and any additional role condition.
  Initial routes are **public** and **role-restricted**.
- **Canonical Documentation Corpus:** The published LiveStore documentation
  aggregate at `https://docs.livestore.dev/llms-full.txt` from which the
  assistant derives answers.
- **Documentation Snapshot:** One identifiable retrieval or materialization of
  the Canonical Documentation Corpus, carrying a revision or content digest and
  its available source references.
- **Answer Engine:** The replaceable boundary that proposes a Grounded Answer
  from a Query, optional Query Context, and Documentation Snapshot. _Avoid:_ AI
  as the name of the subsystem; a particular provider is one realization.
- **Grounded Answer:** A bounded Discord-ready explanation whose substantive
  claims are supported by its Documentation Snapshot and whose uncertainty is
  explicit.
- **Source Reference:** A verifiable pointer to the published documentation
  supporting a Grounded Answer. It must be present in or mechanically derived
  from the Documentation Snapshot.
- **Answer Provenance:** Non-secret metadata sufficient to identify the
  Documentation Snapshot and Answer Engine configuration used for an answer;
  it excludes raw Query and Query Context content.

## Structure

```text
Audience Policy ----allows----> Docs Request
                                  |      |
                           contains      +--- selected by ---> Context Policy
                                  |                           |
                                Query                   Query Context
                                  |                           |
                                  +-------------+-------------+
                                                |
Documentation Snapshot ----grounds----> Answer Engine
                                                |
                                                v
                                         Grounded Answer
                                          |           |
                                    supported by   described by
                                          |           |
                                  Source Reference  Answer Provenance
```

The leitwort is **grounded**: the corpus grounds the engine, source references
ground the answer, and provenance makes that grounding diagnosable.
