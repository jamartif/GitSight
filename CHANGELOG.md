# Changelog

## 0.2.1

### Seguridad
- Panel de detalles: un mensaje de commit ya no puede crear enlaces propios (p. ej. `[#1](command:...)`). Solo se enlazan referencias `#123` hacia la URL https de issues del remoto, y el panel tiene `enableCommandUris: false`.
- Hovers: los enlaces de comando están limitados a los comandos de GitSight.
- Las revisiones que empiezan por `-` se rechazan antes de llegar a git (evita inyección de opciones como `--output=<archivo>`). La búsqueda por SHA solo acepta hexadecimal.
- Release workflow: la versión introducida a mano se pasa por variable de entorno en lugar de interpolarse en el script.

### Cambios
- La búsqueda por autor trata el texto literalmente (`--fixed-strings`), igual que la búsqueda por mensaje.
- `branchOrigin` cachea el historial de cada rama mientras no cambie su punta y limita a 6 los procesos git simultáneos.

## 0.2.0

- Detalles del commit: muestra la rama donde se hizo el commit, la rama de la que partió (con el commit de origen) y las ramas que lo contienen. Recupera el nombre de ramas borradas a partir del mensaje del merge.
- Corregido el recuento de archivos duplicado en las estadísticas del commit.

## 0.1.0

- Primera versión: blame en línea y barra de estado, hovers, CodeLens, anotaciones de archivo (blame, heatmap, cambios), vistas de Commits, Historial de archivo, Historial de líneas, Ramas, Remotos, Tags, Stashes, Worktrees, Contribuidores y Búsqueda/Comparación, grafo de commits interactivo, panel de detalles de commit, enlaces a GitHub/GitLab/Bitbucket/Azure DevOps/Gitea y acciones Git (checkout, merge, rebase, cherry-pick, revert, reset, tags, stash, worktrees).
