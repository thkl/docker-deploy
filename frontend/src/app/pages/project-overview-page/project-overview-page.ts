import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-project-overview-page',
  imports: [RouterLink],
  templateUrl: './project-overview-page.html',
  styleUrl: './project-overview-page.scss',
})
export class ProjectOverviewPage implements OnInit {
  protected readonly store = inject(ProjectStore);
  private readonly route = inject(ActivatedRoute);

  ngOnInit() {
    this.route.paramMap.subscribe((params) => {
      const name = params.get('name');
      if (name) {
        this.store.selectProject(name);
      }
    });
  }
}

