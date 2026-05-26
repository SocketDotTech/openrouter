.PHONY: deploy-openrouter check-openrouter

OPENROUTER_NETWORKS = ethereum polygon base optimism arbitrum bsc worldchain sonic ink avalanche unichain berachain scroll hyperEvm plasma monad linea tempo mantle gnosis katana mode

deploy-openrouter:
	$(foreach network, $(OPENROUTER_NETWORKS), npx hardhat run scripts/deploy/deployOpenRouter.ts --network $(network) & ) wait
	@echo "Deployed OpenRouter on all networks"

check-openrouter:
	$(foreach network, $(OPENROUTER_NETWORKS), npx hardhat run scripts/deploy/checkOpenRouterDeployment.ts --network $(network) & ) wait
	@echo "Checked OpenRouter deployment on all networks"
