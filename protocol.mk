.PHONY: deploy-openrouter deploy-openrouter-cancun deploy-openrouter-shanghai deploy-allowance-holder deploy-across-manipulator check-openrouter check-allowance-holder check-across-manipulator

OPENROUTER_NETWORKS = ethereum polygon base optimism arbitrum bsc worldchain sonic ink avalanche unichain berachain scroll hyperEvm plasma monad linea mantle gnosis katana mode megaeth plume blast soneium sei
ALLOWANCE_HOLDER_NETWORKS = ethereum polygon base optimism arbitrum bsc worldchain sonic ink avalanche unichain berachain scroll hyperEvm plasma monad linea mantle gnosis katana mode megaeth plume blast soneium sei tempo

# Chains supported by both Across (bungee-backend) and OpenRouter (protocol.mk).
ACROSS_MANIPULATOR_NETWORKS = ethereum polygon base optimism arbitrum bsc worldchain ink unichain scroll hyperEvm plasma monad linea tempo mode

deploy-openrouter:
	npx ts-node scripts/deploy/deployOpenRouterByBuildProfile.ts $(OPENROUTER_NETWORKS)
	@echo "Deployed OpenRouter on all networks"

deploy-openrouter-cancun:
	npx ts-node scripts/deploy/deployOpenRouterByBuildProfile.ts --variant cancun $(OPENROUTER_NETWORKS)
	@echo "Deployed OpenRouter on all Cancun networks"

deploy-openrouter-shanghai:
	npx ts-node scripts/deploy/deployOpenRouterByBuildProfile.ts --variant shanghai $(OPENROUTER_NETWORKS)
	@echo "Deployed OpenRouter on all Shanghai networks"

deploy-allowance-holder:
	$(foreach network, $(ALLOWANCE_HOLDER_NETWORKS), npx hardhat run scripts/deploy/deployAllowanceHolder.ts --network $(network) & ) wait
	@echo "Deployed AllowanceHolder on all networks"

deploy-across-manipulator:
	$(foreach network, $(ACROSS_MANIPULATOR_NETWORKS), npx hardhat run scripts/deploy/deployAcrossERC20AmountManipulator.ts --network $(network) & ) wait
	@echo "Deployed AcrossERC20AmountManipulator on all common networks"

check-openrouter:
	$(foreach network, $(OPENROUTER_NETWORKS), npx hardhat run scripts/deploy/checkOpenRouterDeployment.ts --network $(network) & ) wait
	@echo "Checked OpenRouter deployment on all networks"

check-allowance-holder:
	$(foreach network, $(ALLOWANCE_HOLDER_NETWORKS), npx hardhat run scripts/deploy/checkAllowanceHolderDeployment.ts --network $(network) & ) wait
	@echo "Checked AllowanceHolder deployment on all networks"

check-across-manipulator:
	$(foreach network, $(ACROSS_MANIPULATOR_NETWORKS), npx hardhat run scripts/deploy/checkAcrossManipulatorDeployment.ts --network $(network) & ) wait
	@echo "Checked AcrossERC20AmountManipulator deployment on all common networks"
