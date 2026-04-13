# GitHub Pages Deployment

This project is configured to be deployed to GitHub Pages using GitHub Actions.

## Setup Instructions

1. **Push to GitHub**: Ensure your code is pushed to a GitHub repository.
2. **Enable GitHub Pages**:
   - Go to your repository on GitHub.
   - Click on **Settings** > **Pages**.
   - Under **Build and deployment** > **Source**, select **GitHub Actions**.
3. **Trigger Deployment**:
   - The deployment will automatically trigger whenever you push to the `main` branch.
   - You can also manually trigger it from the **Actions** tab.

## Configuration Details

- **Workflow**: Located at `.github/workflows/deploy.yml`.
- **Vite Base Path**: Configured as `./` in `vite.config.ts` to support subpath deployments.
- **Build Output**: The `dist` directory is uploaded and deployed.

## Environment Variables

If your application uses the Gemini API, you must add your API key as a secret:
1. Go to **Settings** > **Secrets and variables** > **Actions**.
2. Click **New repository secret**.
3. Name: `GEMINI_API_KEY`
4. Value: Your actual API key.
5. Update your workflow if you want to pass this secret during the build (though for client-side apps, it's usually better to handle keys securely).
