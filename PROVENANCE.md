# Source provenance

OIO Local was developed and qualified in the private OIO Business repository
before becoming an independent product repository.

- Private source repository: `agpaalal/oio-co`
- Qualified plugin source commit: `e7828e5d24dda86dd1033e8be8a110afe7c76c08`
- Closing documentation commit: `da64323b453deb602e7c31e72084a16727da226d`
- Export boundary: `plugins/oio-local`, its marketplace manifests, its
  Local-only tests and fixtures, and its upstream reconciliation workflow

The plugin tree did not change between the qualified source commit and the
closing documentation commit. OIO Business runtime source, history,
infrastructure, databases, internal receipts, and product-design records were
not imported.

The standalone extraction changes only public distribution boundaries:

- removes private workstation defaults;
- points OIO-owned skill provenance to this repository;
- adds standalone test, contribution, security, and installation documentation.

The selected Matt Pocock skills retain their own exact upstream identities and
license evidence inside the plugin bundle.
