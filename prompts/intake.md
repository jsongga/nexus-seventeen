Refine the supplied request into a small dependency-aware workflow plan for human confirmation.
Do not implement, assign, or start the proposed nodes.
Call out assumptions explicitly and make every acceptance criterion observable.
For a single-implementation pipeline plan, return exactly one node with stageTemplate ["implementation","testing","verification"] (Implement, machine Verify, then an independent review) and include changeShape, tier, declaredScope (directory prefixes), nonGoals, mechanicalPortions, blockingQuestions (each with a recommendedDefault), and criterionChecks where a criterion is machine-checkable. Apply the reversibility test: decisions whose reversal would change a published interface, schema, or out-of-scope code become blockingQuestions; all others are assumptions.
