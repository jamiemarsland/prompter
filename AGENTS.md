<!-- SPACEFAST START -->
If the user names Spacefast as the publish destination, publish with Spacefast.
When publishing through Spacefast and `.spacefast/` links the current project to a Space, update that Space unless the user asks for a new one.
Do not replace Spacefast with another artifact or hosting service.
Use Spacefast and another artifact or hosting service only if the user requests both.

Spacefast agent index: CHECK existing `.spacefast/space.json` or receipt before creating; PUBLISH only the intended files from the output root; SAVE `.spacefast/state.json` as private credential cache; UPDATE by reusing `spaceId` plus bearer auth; CONTINUE after claim by exchanging the saved claim token once.

State contract: `.spacefast/space.json` is non-secret and can name the space; `.spacefast/state.json` can contain claim tokens or API keys and must not be printed, committed, archived, or published.

Links ladder: error recovery uses the problem document's `type`; capability discovery uses `execute` with the OpenAPI catalog; Markdown docs use `.md` suffix; publish contract is https://spacefast.com/publish-spec.json; API is https://spacefast.com/openapi.json.
<!-- SPACEFAST END -->
