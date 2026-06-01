.PHONY: deploy-openrouter deploy-across-manipulator check-openrouter check-across-manipulator

OPENROUTER_NETWORKS = ethereum polygon base optimism arbitrum bsc worldchain sonic ink avalanche unichain berachain scroll hyperEvm plasma monad linea tempo mantle gnosis katana mode

# Chains supported by both Across (bungee-backend) and OpenRouter (protocol.mk).
ACROSS_MANIPULATOR_NETWORKS = ethereum polygon base optimism arbitrum bsc worldchain ink unichain scroll hyperEvm plasma monad linea tempo mode

deploy-openrouter:
	$(foreach network, $(OPENROUTER_NETWORKS), npx hardhat run scripts/deploy/deployOpenRouter.ts --network $(network) & ) wait
	@echo "Deployed OpenRouter on all networks"

deploy-across-manipulator:
	$(foreach network, $(ACROSS_MANIPULATOR_NETWORKS), npx hardhat run scripts/deploy/deployAcrossERC20AmountManipulator.ts --network $(network) & ) wait
	@echo "Deployed AcrossERC20AmountManipulator on all common networks"

check-openrouter:
	$(foreach network, $(OPENROUTER_NETWORKS), npx hardhat run scripts/deploy/checkOpenRouterDeployment.ts --network $(network) & ) wait
	@echo "Checked OpenRouter deployment on all networks"

check-across-manipulator:
	$(foreach network, $(ACROSS_MANIPULATOR_NETWORKS), npx hardhat run scripts/deploy/checkAcrossManipulatorDeployment.ts --network $(network) & ) wait
	@echo "Checked AcrossERC20AmountManipulator deployment on all common networks"
