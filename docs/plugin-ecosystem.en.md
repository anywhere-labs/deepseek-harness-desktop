# DSH Plugin Ecosystem Manifesto

[中文](plugin-ecosystem.md) | English

The DSH plugin ecosystem is growing quickly. The more plugins there are, the more their ability to work together matters: if every plugin assumes or even overrides another plugin's internals, installing a few plugins starts to conflict and the ecosystem fragments. This is nobody's fault — it is the natural result of missing shared conventions.

## Our vision

We want to build an **open, composable, and sustainable** DSH plugin ecosystem:

- **Open**: anyone can participate; official, desktop, and third-party plugins compose on the same platform as equals.
- **Composable**: plugins extend against the same conventions, so they can be installed together and work together without interfering with each other.
- **Sustainable**: upgrades stay backward compatible, so the ecosystem can evolve long-term without being rebuilt from scratch.

## Three principles we advocate

1. **Composition first**: compose capabilities through official slots, services, and patches; do not assume or override other plugins' internals.
2. **Declare clearly**: state the services and slots you depend on; do not rely on runtime coincidences.
3. **Compatibility first**: keep upgrades backward compatible and never break existing compositions.

## The desktop shell is the first example

DSH Desktop is the first practitioner of this approach: the desktop shell itself is an ordinary DSH plugin on the same composition path as official and third-party plugins, with no special privileges. We did not fork upstream source into a fixed shell — we made "the desktop" an equal member of the plugin ecosystem.

## A living document, built with the community

This manifesto is not a unilateral rulebook. It is a **living document**: it follows ecosystem practice and accepts community discussion and revision. Any author can propose changes through issues, discussions, or pull requests.

## The plugin marketplace: making conventions the beneficial choice

Once the plugin marketplace ships, plugins that follow this manifesto will be easier to discover, install, and trust. We want convention-driven development to be the beneficial choice for every author, not an extra burden.

## From a manifesto to a testable contract

[DSH Community Fabric](../dsh-community-fabric/README.md) is turning this vision into a public Draft for manifests, capabilities, Host Descriptors, and events. It currently contains documentation only, not a released standard or runtime; plugins still use existing DSH and Cordis APIs today.

Fabric capabilities begin as compatibility, consent, and audit declarations. They do not present in-process JavaScript as a security sandbox. Only a Host with evidence of real isolation may claim technical permission enforcement.

The market is still in its [product and safety design phase](../dsh-community-market/README.md), with no usable page or installer yet. Catalog inclusion means that a project matched catalog rules; it is not a security review or endorsement.

## How to participate

- Learn how plugins are written in [plugin development](plugin-development.en.md).
- Read and comment on [Community Fabric RFC 0001](../dsh-community-fabric/docs/rfcs/0001-plugin-manifest-capabilities-events.md).
- Learn how to install and manage plugins in the [user guide](user-guide.en.md).
- Share your thoughts on this manifesto through issues and discussions.
