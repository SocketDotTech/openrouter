#!/bin/bash

# Ensure 1Password CLI is authenticated
if ! op whoami &>/dev/null; then
    echo "🔐 Not authenticated with 1Password CLI. Please sign in first."
    eval $(op signin)
fi

# Export environment variables from 1Password
echo "🔄 Loading environment variables from 1Password..."

export DEPLOYER_PRIVATE_KEY="$(op read op://socket-prod/openrouter-deployer/password)"

echo "✅ Environment variables loaded successfully!"